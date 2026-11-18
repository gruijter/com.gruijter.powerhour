/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const EnergyExclude = require('../helpers/EnergyExclude');
const ECB = require('../providers/ECB');
const FORECAST = require('../providers/Stekker');
const { getPriceChart } = require('../charts/PriceChart');
const PriceLevels = require('../helpers/PriceLevels');
const { imageUrlToStream } = require('../charts/ImageHelpers');
const PriceCalculator = require('../PriceCalculator');
const DapFlows = require('../flows/DapFlows');
const DeviceMigrator = require('../DeviceMigrator');
const CapabilityOptions = require('../helpers/CapabilityOptions');
const PriceFetchStrategy = require('../strategies/PriceFetchStrategy');
const TimeHelpers = require('../helpers/TimeHelpers');
const PriceDrivers = require('../helpers/PriceDrivers');
const FlowScan = require('../helpers/FlowScan');
const MoneyUnit = require('../helpers/MoneyUnit');
const { awaitMigration } = require('../helpers/Util');
const PriceShift = require('../helpers/PriceShift');
const PriceIntervalGroups = require('../helpers/PriceIntervalGroups');
const LoadSpread = require('../helpers/LoadSpread');
const FileStore = require('../helpers/FileStore');
const SettingsView = require('../helpers/SettingsView');
const MigrationNotice = require('../helpers/MigrationNotice');
const { restartDevice, setCapability } = require('./MeterDeviceMixin');

class MyDevice extends Homey.Device {

  async setSettings(settings) {
    await super.setSettings(settings);
    await SettingsView.afterSet(this, settings).catch((err) => this.error(err));
  }

  static STORED_PRICES = ['prices', 'marketPrices', 'rawCombinedPrices', 'rawMarketPrices', 'rawForecastPrices', 'priceHistory'];

  async onInit() {
    this.initRunning = this.initDevice();
    return this.initRunning;
  }

  async initDevice() {
    try {
      this.destroyListeners();
      this.restarting = false;
      this.initReady = false;
      this.lastBroadcast = null;
      this.flows = this.createFlows();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.settings = this.getSettings();
      this.timeZone = this.homey.clock.getTimezone();

      await FileStore.open(this, MyDevice.STORED_PRICES);
      this.prices = this.restorePrices('prices');
      if (this.prices.length === 0) this.prices = [{ time: null, price: null, muPrice: null }];

      this.priceHistory = this.restorePrices('priceHistory');
      if (this.priceHistory && this.priceHistory.length > 0) {
        const cutoffTime = Date.now() - (48 * 60 * 60 * 1000);
        this.prices = this.mergePriceArrays(this.priceHistory, this.prices, cutoffTime);
      }

      this.marketPrices = this.restorePrices('marketPrices');
      this.rawCombinedPrices = this.restorePrices('rawCombinedPrices');
      this.rawMarketPrices = this.restorePrices('rawMarketPrices');
      this.rawForecastPrices = this.restorePrices('rawForecastPrices');
      this.pricesProvider = this.getStoreValue('pricesProvider');

      this.priceInterval = PriceDrivers.intervalOf(this.driver.id, this.settings);
      this.commodity = PriceDrivers.commodityOf(this.driver.id, this.settings);
      this.hasExport = this.commodity === 'power';

      if (!this.migrated) {
        this.migration = this.migrate();
        await this.migration;
      }
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: this.capabilitiesRebuilt });
      this.capabilitiesRebuilt = false;
      this.currencyChanged = false;

      const exportMigrated = this.getStoreValue('exportPriceSettingsMigrated');
      if (!exportMigrated) {
        const s = this.settings;
        const hasCustomExportSettings = s.export_ignore_market_price !== false
          || s.export_variableMarkup !== 0
          || s.export_variableMarkupAbsPrice !== 0
          || s.export_fixedMarkup !== 0
          || s.export_fixedMarkupTOD !== ''
          || s.export_fixedMarkupWeekend !== 0;

        if (!hasCustomExportSettings) {
          this.log('Migrating import price settings to export price settings');
          const newSettings = {
            export_ignore_market_price: s.ignore_market_price,
            export_variableMarkup: s.variableMarkup,
            export_variableMarkupAbsPrice: s.variableMarkupAbsPrice,
            export_fixedMarkup: s.fixedMarkup,
            export_fixedMarkupTOD: s.fixedMarkupTOD,
            export_fixedMarkupWeekend: s.fixedMarkupWeekend,
          };
          try {
            await this.setSettings(newSettings);
            this.settings = this.getSettings();
          } catch (err) {
            this.error('Failed to migrate export settings', err);
          }
        }
        await this.setStoreValue('exportPriceSettingsMigrated', true).catch((err) => this.error(err));
      }

      this.todMarkups = PriceCalculator.parseTOD(this.settings.fixedMarkupTOD);
      this.exportTodMarkups = PriceCalculator.parseTOD(this.settings.export_fixedMarkupTOD);

      this.exchange = new ECB();

      this.priceForecast = null;
      if (this.usesMarketPrices()) {
        if (!this.setupProviders()) {
          this.error(this.getName(), 'no provider found for bidding zone', this.settings.biddingZone);
          return;
        }
      } else {
        this.providers = [];
        this.fetchDelay = 5000 + Math.random() * 5000;
      }
      if (!this.rawCombinedPrices.length) this.fetchDelay = Math.min(this.fetchDelay, 5000 + Math.random() * 5000);

      if (this.rawCombinedPrices.length > 0) {
        let combined = this.rawCombinedPrices;
        let forecast = this.rawForecastPrices;
        if (!this.settings.forecastEnable) {
          combined = this.rawMarketPrices;
          forecast = [];
        }
        await this.storePrices(combined, this.rawMarketPrices, forecast);
      }

      await this.setAvailable().catch((err) => this.error(err));

      if (this.prices && this.prices.length > 0 && this.prices[0].time) {
        this.homey.setTimeout(() => {
          if (this.sessionId !== currentSessionId) return;
          this.setCapabilitiesAndFlows({ noTriggers: true, primeTriggers: true }).catch((err) => this.error(err));
        }, 4000);
      }

      this.initReady = true;
      this.log(`${this.getName()} finished initialization`);

      const startFetching = async () => {
        if (this.sessionId !== currentSessionId) return;
        await this.fetchExchangeRate();
        await this.fetchPrices();
      };
      this.homey.setTimeout(() => {
        startFetching().catch((err) => this.error(err));
      }, this.fetchDelay);
    } catch (error) {
      this.error(error);
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  usesMarketPrices() {
    return true;
  }

  setupProviders() {
    this.providers = [];
    const factories = this.driver.providersFor ? this.driver.providersFor(this.settings) : this.driver.ds.providers;
    const loadedProviders = factories.map((providerFactory) => providerFactory());
    const providers = loadedProviders.filter((Provider) => {
      const provider = new Provider();
      const zones = provider.getBiddingZones();
      return Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
    });

    this.isNordpoolZone = PriceFetchStrategy.isNordpoolZone(this.settings.biddingZone);
    PriceFetchStrategy.sortProviders(providers, this.isNordpoolZone);
    this.hasNordpool = providers.some((p) => p.name === 'Nordpool');

    providers.forEach((Provider, index) => {
      let apiKey = '';
      if (Provider.name === 'ENTSOE') {
        const customKey = this.settings.entsoeApiKey ? this.settings.entsoeApiKey.trim() : '';
        apiKey = customKey || Homey?.env?.ENTSOE_API_KEY;
      }
      this.providers[index] = new Provider({ apiKey, biddingZone: this.settings.biddingZone });
    });

    if (!this.providers[0]) return false;

    this.providerCallState = new Map();

    const requested = this.settings.priceProvider;
    this.preferredProvider = (requested && requested !== 'AUTO'
      && providers.some((Provider) => Provider.name === requested)) ? requested : null;

    this.fetchDelay = PriceFetchStrategy.getFetchDelay(this.providers);
    this.log('Fetch delay set to', Math.round(this.fetchDelay / 1000), 'seconds for', this.providers[0].constructor.name);

    if (this.hasExport && this.settings.forecastEnable) {
      const forecast = new FORECAST();
      const zones = forecast.getBiddingZones();
      const hasZone = Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
      if (hasZone) this.priceForecast = new FORECAST({ biddingZone: this.settings.biddingZone });
    }
    return true;
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    this.destroyListeners();
    await awaitMigration(this);
    await FileStore.close(this);
  }

  destroyListeners() {
    if (this.retryTimeout) this.homey.clearTimeout(this.retryTimeout);
  }

  restorePrices(key) {
    const stored = this.fileStore.get(key);
    if (!stored || stored.length === 0) return [];
    if (stored[0].time) {
      return stored.map((p) => ({ ...p, time: new Date(p.time) }));
    }
    return stored;
  }

  async migrate() {
    try {
      const correctCaps = this.driver.capabilitiesFor
        ? this.driver.capabilitiesFor(this.getSettings()) : this.driver.ds.deviceCapabilities;
      this.log(`checking device migration for ${this.getName()}`);
      this.capabilitiesRebuilt = await DeviceMigrator.migrateCapabilities(this, correctCaps, {
        unavailableMessage: this.homey.__('device_migrating'),
      });
      await DeviceMigrator.migrateClass(this).catch((err) => this.error(err));

      MigrationNotice.noteUpdate(this.homey, this.getSettings().level);
      await this.setSettings({ level: this.homey.app.manifest.version }).catch((err) => this.error(err));
      await SettingsView.update(this).catch((err) => this.error(err));
      this.settings = this.getSettings();
      this.migrated = true;
      return Promise.resolve(this.migrated);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
    }
  }

  onAdded() {
    this.log(`Price device added as device: ${this.getName()}`);
    PriceDrivers.updateConflictWarnings(this.homey).catch((err) => this.error(err));
  }

  onDeleted() {
    this.isDeleted = true;
    this.destroyListeners();
    const group = Number(this.getSettings().tariff_update_group);
    if (group) this.homey.emit(PriceDrivers.REMOVED_EVENT, { commodity: this.commodity, group });
    PriceDrivers.updateConflictWarnings(this.homey).catch((err) => this.error(err));
    FileStore.remove(this).catch(() => {});
    this.log(`Price device deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Price device renamed to: ${name}`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (EnergyExclude.onlyHomeyEnergy(changedKeys)) return undefined;
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (changedKeys.includes('fixedMarkupTOD')) {
      PriceCalculator.parseTOD(newSettings.fixedMarkupTOD);
    }
    if (changedKeys.includes('export_fixedMarkupTOD')) {
      PriceCalculator.parseTOD(newSettings.export_fixedMarkupTOD);
    }
    if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
      this.currencyChanged = true;
    }

    const updateAndRestart = async () => {
      if (changedKeys.some((key) => this.priceSettingKeys().includes(key))) {
        this.settings = newSettings;
        if (this.rawCombinedPrices) {
          await this.storePrices(this.rawCombinedPrices, this.rawMarketPrices, this.rawForecastPrices);
          await this.setCapabilitiesAndFlows({ noTriggers: true });
        }
      }
      await this.restartDevice(5000);
      this.emitGroupLeft(oldSettings, newSettings);
    };

    updateAndRestart().catch((error) => this.error(error));
    return Promise.resolve(true);
  }

  emitGroupLeft(oldSettings, newSettings) {
    const oldGroup = Number(oldSettings.tariff_update_group);
    const oldCommodity = PriceDrivers.commodityOf(this.driver.id, oldSettings);
    if (oldGroup && (oldGroup !== Number(newSettings.tariff_update_group) || oldCommodity !== PriceDrivers.commodityOf(this.driver.id, newSettings))) {
      this.homey.emit(PriceDrivers.REMOVED_EVENT, { commodity: oldCommodity, group: oldGroup });
    }
    PriceDrivers.updateConflictWarnings(this.homey).catch((err) => this.error(err));
  }

  createFlows() {
    return new DapFlows(this);
  }

  capabilityOptions() {
    return CapabilityOptions.currency(this.getCapabilities(), {
      currency: this.settings.currency, decimals: this.settings.decimals, defaultCurrency: '€',
    });
  }

  priceSettingKeys() {
    return [
      'ignore_market_price', 'variableMarkup', 'fixedMarkup', 'fixedMarkupTOD', 'fixedMarkupWeekend', 'variableMarkupAbsPrice', 'exchangeRate',
      'export_ignore_market_price', 'export_variableMarkup', 'export_fixedMarkup', 'export_fixedMarkupTOD', 'export_fixedMarkupWeekend', 'export_variableMarkupAbsPrice',
      'export_show_chart_line',
    ];
  }

  markupPrices(marketPrices) {
    return PriceCalculator.calculateMarkupPrices(marketPrices, this.settings, this.timeZone);
  }

  priceTriggerTokens(price) {
    return { meter_price_h0: price };
  }

  priceTriggerIds() {
    return [
      'price_highest',
      'price_highest_before',
      'price_highest_today',
      'price_above_avg',
      'price_highest_avg',
      'price_lowest',
      'price_lowest_before',
      'price_lowest_today',
      'price_below_avg',
      'price_lowest_avg',
      'price_lowest_avg_before',
      'price_highest_avg_before',
      'price_lowest_between',
      'price_highest_between',
      'price_lowest_avg_between',
      'price_highest_avg_between',
      'price_highest_next_hours',
      'price_lowest_next_hours',
      'price_lowest_next_known_hours',
      'price_highest_next_known_hours',
    ];
  }

  async triggerNewPeriod() {
    const { app } = this.homey;
    if (!app || !app.trigger_new_hour) return;
    await this.flushPriceCharts(app.new_hour);
    await app.trigger_new_hour(this, { H0: this.state.H0, price: this.state.priceNow });
  }

  async triggerNewPrices(tokens, state) {
    const { app } = this.homey;
    if (!app || !app.trigger_new_prices) return;
    await this.flushPriceCharts(app.new_prices, state.period);
    await app.trigger_new_prices(this, tokens, state);
  }

  async flushPriceCharts(card, period) {
    if (!LoadSpread.isPending(this, 'priceCharts')) return;
    let used = true;
    try {
      const argValues = await card.getArgumentValues(this);
      used = argValues.some((a) => !period || a.period === period);
      if (used) {
        const ids = await FlowScan.imageDeviceIds(this.homey);
        if (ids) used = ids.has(this.getId());
      }
    } catch {
    }
    if (used) await LoadSpread.flush(this, 'priceCharts').catch((err) => this.error(err));
  }

  monthAvgCaps() {
    return { thisMonth: 'meter_price_this_month_avg', lastMonth: 'meter_price_last_month_avg' };
  }

  async onHourlyEvent() {
    if (this.isDestroyed) return;
    this.log('new hour event received');
    const currentSessionId = this.sessionId;

    await this.setCapabilitiesAndFlows();

    this.homey.setTimeout(() => {
      if (!this.isDestroyed && this.sessionId === currentSessionId) this.fetchExchangeRate().catch((err) => this.error(err));
    }, Math.random() * 20000);

    this.homey.setTimeout(() => {
      if (!this.isDestroyed && this.sessionId === currentSessionId) this.fetchPrices().catch((err) => this.error(err));
    }, this.fetchDelay);
  }

  async on15mEvent() {
    if (this.isDestroyed || this.priceInterval === 60) return;
    this.log('new 15m event received');
    await this.setCapabilitiesAndFlows();
  }

  getUTCPeriods() {
    return TimeHelpers.getUTCPeriods(this.timeZone, this.priceInterval);
  }

  async runFlowAction(id, args) {
    if (this.flows[id]) {
      await this.ensureCurrentState();
      return this.flows[id](args);
    }
    throw new Error(`Action ${id} not implemented`);
  }

  async runFlowCondition(id, args) {
    if (this.flows[id]) {
      await this.ensureCurrentState();
      return this.flows[id](args);
    }
    throw new Error(`Condition ${id} not implemented`);
  }

  async ensureCurrentState() {
    if (!this.state || !this.prices || !this.prices[0]) return;
    if (this.state.pricesStartTm === this.getUTCPeriods().periodStart.getTime()) return;
    if (!this.stateRefresh) {
      this.stateRefresh = this.setState()
        .catch((err) => this.error(err))
        .finally(() => {
          this.stateRefresh = null;
        });
    }
    await this.stateRefresh;
  }

  async runFlowTrigger(id, args, state) {
    if (this.flows[id]) {
      const result = await this.flows[id](args);
      return this.flows.triggerEdge ? this.flows.triggerEdge(id, args, state, result) : result;
    }
    throw new Error(`Trigger ${id} not implemented`);
  }

  async fetchExchangeRate() {
    try {
      const currency = this.settings.fetchExchangeRate;
      if (currency && currency !== 'NONE') {
        this.log(`fetching exchange rate with ${currency}`);
        const rates = await this.exchange.getRates();
        const val = Number(rates[currency]);
        if (!Number.isFinite(val)) throw Error(`result is not a number: ${val}`);
        if (val !== this.settings.exchangeRate) {
          this.log('new exchange rate:', val);
          await this.setSettings({ exchangeRate: val }).catch((err) => this.error(err));
          this.settings = this.getSettings();
          if (this.rawCombinedPrices) {
            await this.storePrices(this.rawCombinedPrices, this.rawMarketPrices, this.rawForecastPrices);
            await this.setCapabilitiesAndFlows({ noTriggers: true });
          }
        }
      }
    } catch (error) {
      this.error(error);
    }
  }

  async fetchPrices() {
    if (this.isFetchingPrices) {
      this.log('Already fetching prices, skipping concurrent request.');
      return;
    }
    this.isFetchingPrices = true;

    try {
      this.log(this.getName(), 'fetching prices...');
      const currentSessionId = this.sessionId;
      const periods = this.getUTCPeriods();
      const resolution = `PT${this.priceInterval}M`;

      const providersToUse = PriceFetchStrategy.filterProviders(this.providers, this.settings.priceProvider, (msg) => this.log(msg));

      const skipCheck = PriceFetchStrategy.shouldSkipFetch(this.marketPrices, periods);
      if (skipCheck.skip) {
        this.log(`Skipping fetch: ${skipCheck.reason}`);
        return;
      }

      const validator = async (prices) => {
        if (this.sessionId !== currentSessionId) throw new Error('Session changed');
        await this.checkPricesValidity(prices, periods);
      };

      const logger = (msg) => this.log(msg);

      const { prices: newMarketPrices, deferredUntil, called } = await PriceFetchStrategy.fetchPrices(
        providersToUse, periods, resolution, validator, logger,
        {
          storedPrices: this.rawMarketPrices,
          isNordpoolZone: this.isNordpoolZone,
          priceInterval: this.priceInterval,
          callState: this.providerCallState,
          preferred: this.preferredProvider,
        },
      );

      if (this.sessionId !== currentSessionId) return;

      const retryAction = (called === 0 && !newMarketPrices)
        ? null
        : PriceFetchStrategy.determineRetry(newMarketPrices, periods, this.isNordpoolZone, this.hasNordpool);

      if (newMarketPrices) {
        const oldProvider = this.pricesProvider;
        await this.processMarketPrices(newMarketPrices, oldProvider);
      } else if (called === 0) {
        this.log('No provider was called: stored prices are complete, or all providers are rate limited');
      }

      this.scheduleNextFetch(retryAction, deferredUntil);
    } catch (error) {
      this.error(error);
    } finally {
      this.isFetchingPrices = false;
    }
  }

  scheduleNextFetch(retryAction, deferredUntil) {
    let minutes = retryAction ? retryAction.minutes : null;
    let reason = retryAction ? retryAction.reason : null;

    if (deferredUntil) {
      const deferMinutes = Math.ceil((deferredUntil - Date.now()) / (60 * 1000));
      if (deferMinutes <= 60 && (minutes === null || deferMinutes < minutes)) {
        minutes = Math.max(1, deferMinutes);
        reason = 'Waiting for a rate limited provider';
      }
    }

    if (minutes === null) return;
    this.log(`${reason}. Retrying in ${minutes} mins.`);
    this.scheduleRetry(minutes);
  }

  scheduleRetry(minutes) {
    if (this.retryTimeout) this.homey.clearTimeout(this.retryTimeout);
    const delay = (minutes * 60 * 1000) + (Math.random() * 60 * 1000);
    this.retryTimeout = this.homey.setTimeout(() => {
      if (!this.isDestroyed) this.fetchPrices().catch((err) => this.error(err));
    }, delay);
  }

  async processMarketPrices(fetchedMarketPrices, oldProvider) {
    const periods = this.getUTCPeriods();
    await this.checkPricesValidity(fetchedMarketPrices, periods);

    const newMarketPrices = PriceFetchStrategy.mergeByAuthority(
      this.rawMarketPrices, fetchedMarketPrices, this.isNordpoolZone, (msg) => this.log(msg), this.preferredProvider,
    );
    await this.updatePricesProvider(newMarketPrices, periods);

    const providerChanged = oldProvider && newMarketPrices.provider && oldProvider !== newMarketPrices.provider;
    if (providerChanged && this.rawMarketPrices && this.rawMarketPrices.length > 0) {
      const epsilon = 5;

      if (newMarketPrices.length <= this.rawMarketPrices.length) {
        let isDifferent = false;
        for (let i = 0; i < newMarketPrices.length; i += 1) {
          const oldTime = new Date(this.rawMarketPrices[i].time).getTime();
          const newTime = new Date(newMarketPrices[i].time).getTime();
          if (oldTime !== newTime || Math.abs(newMarketPrices[i].price - this.rawMarketPrices[i].price) > epsilon) {
            isDifferent = true;
            break;
          }
        }

        if (!isDifferent) {
          this.log('New market prices are within margin of existing prices. Aligning old values to prevent flip-flop.');
          for (let i = 0; i < newMarketPrices.length; i += 1) {
            newMarketPrices[i].price = this.rawMarketPrices[i].price;
          }
        }
      } else {
        let isTodayDifferent = false;
        for (let i = 0; i < this.rawMarketPrices.length; i += 1) {
          const oldTime = new Date(this.rawMarketPrices[i].time).getTime();
          const newTime = new Date(newMarketPrices[i].time).getTime();
          if (oldTime !== newTime || Math.abs(newMarketPrices[i].price - this.rawMarketPrices[i].price) > epsilon) {
            isTodayDifferent = true;
            break;
          }
        }
        if (!isTodayDifferent) {
          this.log('Existing market prices match the start of new prices. Aligning old values to prevent flip-flop for today.');
          for (let i = 0; i < this.rawMarketPrices.length; i += 1) {
            newMarketPrices[i].price = this.rawMarketPrices[i].price;
          }
        }
      }
    }

    let newForecastPrices;
    let newCombinedPrices = [...newMarketPrices];
    if (this.settings.forecastEnable && this.priceForecast && newMarketPrices && newMarketPrices[0]) {
      this.log(this.getName(), 'fetching forecast prices (when available)');
      const resolution = `PT${this.priceInterval}M`;
      let forecast = await this.priceForecast.getPrices({ forecast: true, resolution }).catch((err) => this.log(err));
      if (forecast && forecast.length > 0) {
        forecast = forecast.map((p) => ({ ...p, isForecast: true }));
        const lastMarketTime = newMarketPrices.slice(-1)[0].time;
        const limit = 24 * (60 / this.priceInterval);
        forecast = forecast
          .filter((hourInfo) => new Date(hourInfo.time) > new Date(lastMarketTime))
          .slice(0, limit);

        if (this.priceInterval === 15 && forecast.length > 1) {
          const firstStepMs = new Date(forecast[1].time) - new Date(forecast[0].time);
          if (firstStepMs === 3600000) {
            const interpolated = [];
            for (const item of forecast) {
              const baseTime = new Date(item.time).getTime();
              for (let step = 0; step < 4; step += 1) {
                interpolated.push({
                  ...item,
                  time: new Date(baseTime + step * 15 * 60 * 1000),
                });
              }
            }
            forecast = interpolated.slice(0, limit);
          }
        }

        const combined = newMarketPrices.concat(forecast);
        const valid = await this.checkPricesValidity(combined, periods).catch((err) => {
          this.log(`Forecast validation skipped: ${err.message}`);
          return false;
        });
        if (valid) {
          newForecastPrices = forecast;
          newCombinedPrices = combined;
        } else {
          forecast = [...this.rawCombinedPrices]
            .filter((hourInfo) => hourInfo.isForecast && new Date(hourInfo.time) > new Date(lastMarketTime))
            .slice(0, limit);
          const combined2 = newMarketPrices.concat(forecast);
          const valid2 = await this.checkPricesValidity(combined2, periods).catch((err) => {
            this.log(`Stored forecast validation skipped: ${err.message}`);
            return false;
          });
          if (valid2) {
            newForecastPrices = forecast;
            newCombinedPrices = combined2;
          }
        }
      }
    }

    const oldPrices = [...this.prices];
    await this.storePrices(newCombinedPrices, newMarketPrices, newForecastPrices);
    await this.setCapabilitiesAndFlows({ noTriggers: true });

    this.emitPricesUpdated('new-prices-fetched');

    await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'this_day', periods);
    await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'tomorrow', periods);
    await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'next_hours', periods);
  }

  async updatePricesProvider(marketPrices, periods) {
    if (!Array.isArray(marketPrices) || marketPrices.length === 0) return;
    const current = marketPrices.find((price) => new Date(price.time).getTime() === periods.periodStart.getTime());
    const provider = (current && current.provider) || marketPrices.provider;
    if (!provider || provider === this.pricesProvider) return;
    this.pricesProvider = provider;
    await this.setStoreValue('pricesProvider', this.pricesProvider).catch((err) => this.error(err));
  }

  getProviderForPeriod(period) {
    const periods = this.getUTCPeriods();
    const range = PriceCalculator.getPeriodRange(periods, period);
    const start = range.start.getTime();
    const end = range.end.getTime();

    const providers = [];
    if (Array.isArray(this.rawMarketPrices)) {
      this.rawMarketPrices.forEach((price) => {
        if (!price || !price.time || price.isForecast) return;
        const time = new Date(price.time).getTime();
        if (time < start || time >= end) return;
        const name = price.provider || this.pricesProvider || 'Unknown';
        if (!providers.includes(name)) providers.push(name);
      });
    }
    if (providers.length > 0) return providers.join('+');

    const hasForecast = Array.isArray(this.rawForecastPrices) && this.rawForecastPrices.some((price) => {
      if (!price || !price.time) return false;
      const time = new Date(price.time).getTime();
      return time >= start && time < end;
    });
    if (hasForecast && this.priceForecast) return `${this.priceForecast.constructor.name} (forecast)`;

    return '';
  }

  async checkNewMarketPrices(oldPrices, newPrices, period, periods) {
    return this.flows.checkNewMarketPrices(oldPrices, newPrices, period, periods);
  }

  async checkPricesValidity(newMarketPrices, periods) {
    if ((!newMarketPrices || !newMarketPrices[0] || !newMarketPrices[0].time)) throw Error('Unable to fetch prices');
    newMarketPrices.sort((a, b) => new Date(a.time) - new Date(b.time));
    const hasCurrentPeriod = newMarketPrices.some((hourInfo) => hourInfo.time.getTime() === periods.periodStart.getTime());
    if (!hasCurrentPeriod) throw Error('Fetched prices are missing the current period');
    let previousTime = new Date(newMarketPrices[0].time);
    let consecutive = true;
    const intervalMs = this.priceInterval * 60 * 1000;
    newMarketPrices.forEach((price, idx) => {
      if (idx !== 0) {
        consecutive = consecutive && (new Date(price.time) - previousTime) === intervalMs;
        previousTime = new Date(price.time);
      }
    });
    if (!consecutive) {
      this.log(this.getName(), newMarketPrices);
      throw Error('Fetched prices are not in consecutive order');
    }
    const oldPrices = [...this.prices];
    if (oldPrices && oldPrices[0] && oldPrices[0].time) {
      const oldMarketPrices = oldPrices.filter((p) => !p.isForecast);
      if (oldMarketPrices.length > 0) {
        if (newMarketPrices.slice(-1)[0].time < oldMarketPrices.slice(-1)[0].time) throw Error('Fetched prices are older then the stored prices');
      }
    }
    return true;
  }

  mergePriceArrays(oldList, newList, cutoffTime) {
    const map = new Map();
    if (Array.isArray(oldList)) {
      oldList.forEach((p) => {
        if (p && p.time) {
          const t = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
          if (!Number.isNaN(t) && t >= cutoffTime) {
            map.set(t, { ...p, time: new Date(t) });
          }
        }
      });
    }
    if (Array.isArray(newList)) {
      newList.forEach((p) => {
        if (p && p.time) {
          const t = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
          if (!Number.isNaN(t)) {
            map.set(t, { ...p, time: new Date(t) });
          }
        }
      });
    }
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  async storePrices(newCombinedPrices, newMarketPrices, newForecastPrices) {
    try {
      const cutoffTime = Date.now() - (48 * 60 * 60 * 1000);
      const muPrices = this.markupPrices(newCombinedPrices);

      this.prices = this.mergePriceArrays(this.prices, muPrices, cutoffTime);
      this.rawCombinedPrices = this.mergePriceArrays(this.rawCombinedPrices, newCombinedPrices, cutoffTime);
      this.fileStore.set('prices', this.prices);
      this.fileStore.set('rawCombinedPrices', this.rawCombinedPrices);

      if (newMarketPrices) {
        const muMarketPrices = this.markupPrices(newMarketPrices);
        this.marketPrices = this.mergePriceArrays(this.marketPrices, muMarketPrices, cutoffTime);
        this.rawMarketPrices = this.mergePriceArrays(this.rawMarketPrices, newMarketPrices, cutoffTime);
        this.fileStore.set('marketPrices', this.marketPrices);
        this.fileStore.set('rawMarketPrices', this.rawMarketPrices);
      }
      if (newForecastPrices) {
        const muForecastPrices = this.markupPrices(newForecastPrices);
        this.forecastPrices = [...muForecastPrices];
        this.rawForecastPrices = [...newForecastPrices];
        this.fileStore.set('rawForecastPrices', this.rawForecastPrices);
      }
    } catch (error) {
      this.error(error);
    }
  }

  async setState() {
    if (!this.prices || !this.prices[0] || !this.prices[0].time) throw Error('no price info available');
    const periods = this.getUTCPeriods();

    const pricesYesterdayObjs = PriceCalculator.selectPriceObjects(this.prices, periods.yesterdayStart, periods.todayStart);
    if (pricesYesterdayObjs.length > 0) {
      this.priceHistory = pricesYesterdayObjs;
      this.fileStore.set('priceHistory', pricesYesterdayObjs);
    }
    const pricesYesterday = pricesYesterdayObjs.map((p) => p.muPrice);

    const pricesThisDay = PriceCalculator.selectPrices(this.prices, periods.todayStart, periods.tomorrowStart);
    const statsThisDay = PriceCalculator.calculateStats(pricesThisDay);

    const { H0, Q0 } = periods;
    const pricesNowArray = PriceCalculator.selectPrices(this.prices, periods.periodStart, periods.tomorrowStart);
    let priceNow = pricesNowArray[0];
    if (priceNow === undefined) priceNow = null;

    const exportPricesNowArray = PriceCalculator.selectExportPrices(this.prices, periods.periodStart, periods.tomorrowStart);
    let exportPriceNow = exportPricesNowArray[0];
    if (exportPriceNow === undefined) exportPriceNow = null;

    const { dayNumber, monthNumber } = periods;
    const lastDayNumber = this.getStoreValue('lastDayNumber');
    const lastMonthNumber = this.getStoreValue('lastMonthNumber');
    const monthCaps = this.monthAvgCaps();
    let priceThisMonthAvg = this.getCapabilityValue(monthCaps.thisMonth);
    let priceLastMonthAvg = this.getCapabilityValue(monthCaps.lastMonth);

    if (!Number.isFinite(priceThisMonthAvg) && Number.isFinite(statsThisDay.avg)) {
      priceThisMonthAvg = statsThisDay.avg;
    }
    if (!Number.isFinite(priceLastMonthAvg) && Number.isFinite(priceThisMonthAvg)) {
      priceLastMonthAvg = priceThisMonthAvg;
    }

    let dayRollover = null;
    if (lastDayNumber !== dayNumber && Number.isFinite(statsThisDay.avg)) {
      dayRollover = { dayNumber };
      if (monthNumber !== lastMonthNumber || dayNumber === 1) {
        priceLastMonthAvg = priceThisMonthAvg;
        priceThisMonthAvg = statsThisDay.avg;
        dayRollover.monthNumber = monthNumber;
      } else {
        priceThisMonthAvg = PriceCalculator.roundPrice((statsThisDay.avg + priceThisMonthAvg * (dayNumber - 1)) / dayNumber);
      }
    }

    const pricesNextHours = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.periodStart)
      .map((hourInfo) => hourInfo.muPrice);
    const exportPricesNextHours = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.periodStart)
      .map((hourInfo) => hourInfo.exportPrice);
    const pricesNextHoursIsForecast = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.periodStart)
      .map((hourInfo) => hourInfo.isForecast);
    const pricesNextHoursMarketLength = this.marketPrices.filter((hourInfo) => hourInfo.time >= periods.periodStart).length;

    const pricesNext8h = PriceCalculator.selectPrices(this.prices, periods.periodStart, (periods.periodStart.getTime() + 8 * 60 * 60 * 1000));
    const statsNext8h = PriceCalculator.calculateStats(pricesNext8h);

    const getLocalHour = (baseDate, index) => {
      if (index === null || index < 0) return null;
      const utcTime = baseDate.getTime() + (index * this.priceInterval * 60 * 1000);
      const localTime = TimeHelpers.toLocalDate(new Date(utcTime), this.timeZone);
      return localTime.getHours() + (localTime.getMinutes() / 60);
    };

    const hourNext8hLowest = getLocalHour(periods.periodStart, statsNext8h.minIndex);
    const hourNext8hHighest = getLocalHour(periods.periodStart, statsNext8h.maxIndex);

    const pricesTomorrow = PriceCalculator.selectPrices(this.prices, periods.tomorrowStart, periods.tomorrowEnd);
    const pricesTomorrowMarketLength = PriceCalculator.selectPrices(this.marketPrices, periods.tomorrowStart, periods.tomorrowEnd).length;

    let statsNextDay = {
      min: null, max: null, avg: null, minIndex: null, maxIndex: null,
    };
    if (pricesTomorrow.length > 6) {
      statsNextDay = PriceCalculator.calculateStats(pricesTomorrow);
    }

    const state = {
      priceinterval: this.priceInterval,
      pricesYesterday,

      priceLastMonthAvg,
      priceThisMonthAvg,
      this_month_avg: priceThisMonthAvg,
      dayNumber,
      monthNumber,
      dayRollover,

      pricesThisDay,
      priceThisDayAvg: statsThisDay.avg,
      this_day_avg: statsThisDay.avg,
      priceThisDayLowest: statsThisDay.min,
      hourThisDayLowest: getLocalHour(periods.todayStart, statsThisDay.minIndex),
      priceThisDayHighest: statsThisDay.max,
      hourThisDayHighest: getLocalHour(periods.todayStart, statsThisDay.maxIndex),

      pricesNextHours,
      exportPricesNextHours,
      pricesNextHoursMarketLength,
      pricesNextHoursIsForecast,
      pricesStartTm: periods.periodStart.getTime(),

      pricesNext8h,
      priceNext8hAvg: statsNext8h.avg,
      next_8h_avg: statsNext8h.avg,
      priceNext8hLowest: statsNext8h.min,
      hourNext8hLowest,
      priceNext8hHighest: statsNext8h.max,
      hourNext8hHighest,

      priceNow,
      exportPriceNow,
      H0,
      Q0,

      pricesTomorrow,
      pricesTomorrowMarketLength,
      priceNextDayAvg: statsNextDay.avg,
      priceNextDayLowest: statsNextDay.min,
      hourNextDayLowest: getLocalHour(periods.tomorrowStart, statsNextDay.minIndex),
      priceNextDayHighest: statsNextDay.max,
      hourNextDayHighest: getLocalHour(periods.tomorrowStart, statsNextDay.maxIndex),
    };
    this.state = state;
  }

  updatePriceCharts() {
    return LoadSpread.run(this, 'priceCharts', () => this.renderPriceCharts());
  }

  async renderPriceCharts() {
    const periods = this.getUTCPeriods();
    const levels = PriceLevels.ofDevice(this);
    const chartEntry = (p) => {
      const lv = levels.get(new Date(p.time).getTime()) || {};
      return {
        price: p.muPrice, exportPrice: p.exportPrice, isForecast: p.isForecast, level: lv.level, levelAlpha: lv.alpha,
      };
    };
    const pricesThisDay = PriceCalculator.selectPriceObjects(this.prices, periods.todayStart, periods.tomorrowStart).map(chartEntry);
    const chartToday = await getPriceChart(pricesThisDay, periods.todayStart, 999, this.priceInterval, this.timeZone, this.settings.export_show_chart_line, true);
    this.chartTodayPrice = chartToday;
    if (!this.todayPriceImage) {
      this.todayPriceImage = await this.homey.images.createImage();
      this.todayPriceImage.setStream(async (stream) => imageUrlToStream(this.chartTodayPrice, stream, this));
      await this.setCameraImage('todayPriceChart', ` ${this.homey.__('today')}`, this.todayPriceImage);
    }
    await this.todayPriceImage.update();

    const pricesTomorrow = PriceCalculator.selectPriceObjects(this.prices, periods.tomorrowStart, periods.tomorrowEnd).map(chartEntry);
    const chartTomorow = await getPriceChart(pricesTomorrow, periods.tomorrowStart, 999, this.priceInterval, this.timeZone, this.settings.export_show_chart_line, false);
    this.chartTomorrowPrice = chartTomorow;
    if (!this.tomorrowPriceImage) {
      this.tomorrowPriceImage = await this.homey.images.createImage();
      this.tomorrowPriceImage.setStream(async (stream) => imageUrlToStream(this.chartTomorrowPrice, stream, this));
      await this.setCameraImage('tomorrowPriceChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowPriceImage);
    }
    await this.tomorrowPriceImage.update();

    const pricesNextHours = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.periodStart)
      .map(chartEntry);
    const chartNextHours = await getPriceChart(pricesNextHours, periods.periodStart, 999, this.priceInterval, this.timeZone, this.settings.export_show_chart_line, false);
    this.chartNextHoursPrice = chartNextHours;
    if (!this.nextHoursPriceImage) {
      this.nextHoursPriceImage = await this.homey.images.createImage();
      this.nextHoursPriceImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursPrice, stream, this));
      await this.setCameraImage('nextHoursPriceChart', ` ${this.homey.__('nextHours')}`, this.nextHoursPriceImage);
    }
    await this.nextHoursPriceImage.update();
  }

  async setPriceCapabilities() {
    await this.setCapability('meter_price_h0_export', this.state.exportPriceNow);
    await this.setCapability('meter_price_this_day_lowest', this.state.priceThisDayLowest);
    await this.setCapability('hour_this_day_lowest', this.state.hourThisDayLowest);
    await this.setCapability('meter_price_next_8h_lowest', this.state.priceNext8hLowest);
    await this.setCapability('hour_next_8h_lowest', this.state.hourNext8hLowest);
    await this.setCapability('meter_price_this_day_highest', this.state.priceThisDayHighest);
    await this.setCapability('hour_this_day_highest', this.state.hourThisDayHighest);
    await this.setCapability('meter_price_next_8h_highest', this.state.priceNext8hHighest);
    await this.setCapability('hour_next_8h_highest', this.state.hourNext8hHighest);
    await this.setCapability('meter_price_this_day_avg', this.state.priceThisDayAvg);
    await this.setCapability('meter_price_this_month_avg', this.state.priceThisMonthAvg);
    await this.setCapability('meter_price_last_month_avg', this.state.priceLastMonthAvg);
    await this.setCapability('meter_price_next_8h_avg', this.state.priceNext8hAvg);
    await this.setCapability('meter_price_next_day_lowest', this.state.priceNextDayLowest);
    await this.setCapability('hour_next_day_lowest', this.state.hourNextDayLowest);
    await this.setCapability('meter_price_next_day_highest', this.state.priceNextDayHighest);
    await this.setCapability('hour_next_day_highest', this.state.hourNextDayHighest);
    await this.setCapability('meter_price_next_day_avg', this.state.priceNextDayAvg);

    const rankThisDay = [...this.state.pricesThisDay]
      .sort((a, b) => a - b)
      .findIndex((val) => val === this.state.priceNow);
    const rankNext8h = [...this.state.pricesNext8h]
      .sort((a, b) => a - b)
      .findIndex((val) => val === this.state.priceNow);
    await this.setCapability('meter_rank_price_h0_this_day', rankThisDay + 1);
    await this.setCapability('meter_rank_price_h0_next_8h', rankNext8h + 1);

    if (this.priceInterval === 15) {
      const prices = this.state.pricesNext8h;
      await this.setCapability('meter_price_h0', prices[0]).catch(this.error);
      await this.setCapability('meter_price_m15', prices[1]).catch(this.error);
      await this.setCapability('meter_price_m30', prices[2]).catch(this.error);
      await this.setCapability('meter_price_m45', prices[3]).catch(this.error);
      await this.setCapability('meter_price_h1', prices[4]).catch(this.error);
      await this.setCapability('meter_price_h2', prices[8]).catch(this.error);
      await this.setCapability('meter_price_h3', prices[12]).catch(this.error);
    } else {
      const allSet = this.state.pricesNext8h.map((price, index) => this.setCapability(`meter_price_h${index}`, price).catch(this.error));
      await Promise.all(allSet);
    }
  }

  async setCapabilitiesAndFlows(options) {
    try {
      if (this.isDestroyed) return;
      await this.setState();

      await this.setPriceCapabilities();
      const { dayRollover } = this.state;
      if (dayRollover) {
        if (dayRollover.monthNumber !== undefined) await this.setStoreValue('lastMonthNumber', dayRollover.monthNumber);
        await this.setStoreValue('lastDayNumber', dayRollover.dayNumber);
      }

      if (typeof this.beforeBroadcast === 'function') await this.beforeBroadcast().catch((err) => this.error(err));

      const targets = [`set_tariff_${this.commodity}_PBTH`];
      const group = this.settings.tariff_update_group;
      if (group) {
        const payload = {
          tariff: this.state.priceNow,
          exportTariff: this.state.exportPriceNow,
          priceInterval: this.priceInterval,
          sourceDeviceId: this.getData().id,
          sourceDeviceName: this.getName(),
          pricesNextHours: this.state.pricesNextHours,
          exportPricesNextHours: this.state.exportPricesNextHours,
          pricesNextHoursMarketLength: this.state.pricesNextHoursMarketLength,
          pricesNextHoursIsForecast: this.state.pricesNextHoursIsForecast,
          pricesStartTm: this.state.pricesStartTm,
          group,
          currency: this.settings.currency || '€',
          moneyDecimals: MoneyUnit.isDecimals(this.settings.moneyDecimals)
            ? Number(this.settings.moneyDecimals) : MoneyUnit.decimalsOf(this.settings.fetchExchangeRate),
          exchangeRate: this.settings.exchangeRate || 1,
        };
        const shiftOnly = PriceShift.isShiftOnly(this.lastBroadcast, payload);
        this.lastBroadcast = payload;
        if (shiftOnly) {
          await Promise.all(targets.map((channel) => PriceIntervalGroups.applyFor(this.homey, {
            channel, group, sourceId: payload.sourceDeviceId, sourceName: payload.sourceDeviceName, interval: payload.priceInterval,
          })));
        } else {
          this.log(`Broadcasting prices to group ${group}: tariff ${payload.tariff}, export ${payload.exportTariff}, `
            + `${(payload.pricesNextHours || []).length} slots of ${payload.priceInterval} min`);
          targets.forEach((sendTo) => {
            this.homey.emit(sendTo, payload);
          });
        }
      }

      await this.updatePriceCharts().catch((err) => this.error(err));

      let app;
      try {
        app = this.homey.app;
      } catch {
      }

      if (!options || !options.noTriggers) {
        if (!this.lastTriggeredState) this.lastTriggeredState = {};

        const periodChanged = this.state.pricesStartTm !== this.lastTriggeredState.pricesStartTm;
        const dayChanged = this.lastTriggeredState.dayNumber !== undefined && this.state.dayNumber !== this.lastTriggeredState.dayNumber;

        if (periodChanged && Number.isFinite(this.state.priceNow)) {
          await this.triggerNewPeriod();

          this.emitPricesUpdated('period-changed');
        }

        if (periodChanged && this.state.pricesNextHours && this.state.pricesNextHours[0]) {
          await this.flows.new_prices_received({ prices: this.state.pricesNextHours, period: 'next_hours' }).catch((err) => this.error(err));
        }
        if (dayChanged) {
          if (this.state.pricesThisDay && this.state.pricesThisDay[0]) {
            await this.flows.new_prices_received({ prices: this.state.pricesThisDay, period: 'this_day' }).catch((err) => this.error(err));
          }
        }
        if (periodChanged) await this.runPriceTriggers(app);

        this.lastTriggeredState.pricesStartTm = this.state.pricesStartTm;
        this.lastTriggeredState.dayNumber = this.state.dayNumber;
      } else if (options.primeTriggers && this.flows.triggerEdge) {
        await this.runPriceTriggers(app, { prime: true });
      }
    } catch (error) {
      this.error(error);
    }
  }

  async runPriceTriggers(app, extraState = {}) {
    if (!app || !Number.isFinite(this.state.priceNow)) return;
    const tokens = this.priceTriggerTokens(Number(this.state.priceNow.toFixed(this.settings.decimals)));
    const state = { pricesStartTm: this.state.pricesStartTm, ...extraState };
    for (const id of this.priceTriggerIds()) {
      if (app[`trigger_${id}`]) await app[`trigger_${id}`](this, tokens, state);
    }
  }

  pricesPayloadEntry(now = new Date()) {
    if (!this.prices || !this.prices[0] || !this.prices[0].time) return null;
    const periodMs = this.priceInterval * 60 * 1000;
    const currentPeriodStart = new Date(Math.floor(now.getTime() / periodMs) * periodMs);
    const settings = this.settings || this.getSettings();
    const slots = this.prices
      .filter((p) => new Date(p.time) >= currentPeriodStart)
      .sort((a, b) => new Date(a.time) - new Date(b.time))
      .map((p) => ({
        time: new Date(p.time).toISOString(),
        importPrice: p.muPrice,
        exportPrice: p.exportPrice,
        isForecast: p.isForecast || false,
      }));
    if (slots.length === 0) return null;
    return {
      deviceId: this.getData().id,
      deviceName: this.getName(),
      driverType: this.driver.id,
      commodity: this.commodity,
      tariffType: settings.tariffType === 'fixed' ? 'fixed' : 'dynamic',
      biddingZone: settings.biddingZone || '',
      currency: settings.currency || '€',
      priceInterval: this.priceInterval,
      slots,
    };
  }

  emitPricesUpdated(reason) {
    try {
      const now = new Date();
      const entry = this.pricesPayloadEntry(now);
      if (!entry) return;
      const payload = {
        generatedAt: now.toISOString(),
        reason,
        prices: [entry],
      };
      this.homey.api.realtime('prices-updated', payload).catch((err) => this.error(err));
      this.log(`Emitted prices-updated (${reason}) with ${entry.slots.length} slots`);
    } catch (err) {
      this.error('emitPricesUpdated failed:', err);
    }
  }

}

Object.assign(MyDevice.prototype, { restartDevice, setCapability });

module.exports = MyDevice;
