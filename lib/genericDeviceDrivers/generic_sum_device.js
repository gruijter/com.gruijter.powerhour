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

const { Device } = require('homey');
const crypto = require('crypto');
const EnergyExclude = require('../helpers/EnergyExclude');
const Budget = require('../Budget');
const BudgetSetup = require('../helpers/BudgetSetup');
const SettingsView = require('../helpers/SettingsView');
const MigrationNotice = require('../helpers/MigrationNotice');
const PairSetup = require('../helpers/PairSetup');

const BUDGET_KEYS = ['start_date', 'budget', 'distribution', 'budget_heating', 'budget_cooling'];
const MinMaxTracker = require('../helpers/MinMaxTracker');
const MeterHelpers = require('../helpers/MeterHelpers');
const SumFlows = require('../flows/SumFlows');
const DeviceMigrator = require('../DeviceMigrator');
const CapabilityOptions = require('../helpers/CapabilityOptions');
const SourceDeviceHelper = require('../helpers/SourceDeviceHelper');
const { setTimeoutPromise, awaitMigration } = require('../helpers/Util');
const TimeHelpers = require('../helpers/TimeHelpers');
const FixValues = require('../helpers/FixValues');
const PriceDrivers = require('../helpers/PriceDrivers');
const FlowScan = require('../helpers/FlowScan');
const MoneyUnit = require('../helpers/MoneyUnit');
const ContractYear = require('../helpers/ContractYear');
const HistoryRestore = require('../helpers/HistoryRestore');
const FileStore = require('../helpers/FileStore');
const MeterDeviceMixin = require('./MeterDeviceMixin');

const STORE_FLUSH_MS = 60 * 1000;

const SILENT_LISTENER_MS = 55 * 60 * 1000;

class SumMeterDevice extends Device {

  async setSettings(settings) {
    await super.setSettings(settings);
    await SettingsView.afterSet(this, settings).catch((err) => this.error(err));
  }

  static get STORE_FLUSH_MS() {
    return STORE_FLUSH_MS;
  }

  async onInit() {
    if (this.ds.cmap) this.ds = { ...this.ds, cmap: { ...this.ds.cmap }, cmapDriver: this.ds.cmap };
    this.initRunning = this.initDevice();
    return this.initRunning;
  }

  setSourceCaps() {
    const base = this.ds.cmapDriver;
    if (!base) return;
    ['meter_source', 'measure_source'].forEach((key) => {
      this.ds.cmap[key] = this.driver.energyCapFor(base[key], this.getSettings());
    });
  }

  async initDevice() {
    try {
      this.restarting = false;
      if (!this.flows) this.flows = new SumFlows(this);
      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.timeZone = this.homey.clock.getTimezone();
      this.settings = this.getSettings();
      this.setSourceCaps();

      if (this.driver.capabilitiesFor(this.settings).some((cap) => !this.hasCapability(cap))) this.migrated = false;
      if (!this.migrated) {
        this.migration = this.migrate();
        await this.migration;
      }
      if (this.sessionId !== currentSessionId) return;

      const caps = this.getCapabilities();
      const { currency, decimals } = MoneyUnit.get(this, '¤');
      await DeviceMigrator.syncCapabilityOptions(this, {
        ...CapabilityOptions.currency(caps, {
          currency, decimals, defaultCurrency: '¤', perUnit: this.getCurrencyUnit(),
        }),
        ...CapabilityOptions.meterDecimals(caps, this.settings.decimals_meter),
      }, { force: this.capabilitiesRebuilt });
      this.capabilitiesRebuilt = false;
      this.currencyChanged = false;
      this.meterDecimalsChanged = false;
      this.migrated = true;
      if (await MeterHelpers.sourceSwitched(this, ['sourceCaps'])) this.shiftNextReading = true;
      await this.setAvailable().catch((err) => this.error(err));
      await PairSetup.updatePriceInfo(this).catch((err) => this.error(err));

      if (this.settings.source_device_type === 'Homey device') {
        let api;
        try {
          api = this.homey.app.api;
        } catch {
        }
        if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
        await this.getSourceDevice();
        await setTimeoutPromise(3 * 1000, this);
        if (this.sessionId !== currentSessionId) return;
      } else this.log(this.getName(), 'Skipping setup of source device. Meter update is done via flow or from Homey Energy');

      await this.initDeviceValues();
      this.loadLocalProfile().catch((err) => this.error(err));

      if (this.sessionId !== currentSessionId) return;
      if (this.settings.source_device_type === 'virtual via flow') await this.updateMeterFromFlow(null);
      else if (this.settings.source_device_type.includes('Homey Energy')) this.startPolling(1);
      else if (this.settings.use_measure_source) {
        this.log(`Warning! ${this.getName()} is not using a cumulative meter as source`);
        await this.addListeners();
        await this.updateMeterFromMeasure(null);
      } else {
        await this.addListeners();
        if (this.getStoreValue('pollSource')) this.startPolling(1);
        else {
          await this.pollMeter()
            .catch((error) => this.setUnavailable(error.message).catch((err) => this.error(err)));
        }
      }
      await this.updateSourceLabel().catch((err) => this.error(err));

      if (typeof this.driver.checkStartPolling === 'function') {
        await this.driver.checkStartPolling();
      }

      this.initReady = true;
      this.homey.setTimeout(() => {
        if (!this.isDestroyed) this.checkPriceSetup().catch((err) => this.error(err));
      }, 60 * 1000);

      if (this.tariffGroupChanged) {
        this.tariffGroupChanged = false;
        await this.driver.updateDeviceTariff(this).catch((err) => this.error(err));
      }
    } catch (error) {
      this.initReady = false;
      this.error(error);
      this.setUnavailable(error.message).catch(this.error);
    }
  }

  async flushStore() {
    if (this.lastMinMax) {
      this.lastMinMaxSaveTm = Date.now();
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    await awaitMigration(this);
    await this.flushStore().catch((err) => this.error(err));
    await FileStore.close(this);
    this.stopPolling();
    this.destroyListeners();
  }

  async migrate() {
    try {
      this.migrated = false;
      this.migrating = true;

      if (this.settings.source_device_type.includes('Homey Energy')) {
        if (this.settings.use_measure_source) {
          await this.setSettings({ use_measure_source: false }).catch((err) => this.error(err));
          this.settings = this.getSettings();
        }
      }

      if (Number(this.settings.interval) > 0) {
        if (!this.settings.source_device_type.includes('Homey Energy')) await this.setStoreValue('pollSource', true).catch((err) => this.error(err));
        await this.setSettings({ interval: 0 }).catch((err) => this.error(err));
        this.settings = this.getSettings();
      }

      const budgetFix = BudgetSetup.migrate(this.settings, this.driver.ds.driverId);
      if (budgetFix) {
        await this.setSettings(budgetFix).catch((err) => this.error(err));
        this.settings = this.getSettings();
      }
      await this.ensureValidSettings();

      const correctCaps = this.driver.capabilitiesFor(this.getSettings());
      const { sessionId } = this;
      this.log(`checking device migration for ${this.getName()}`);
      await this.keepRenamedValues();
      this.capabilitiesRebuilt = await DeviceMigrator.migrateCapabilities(this, correctCaps, {
        shouldAbort: () => this.sessionId !== sessionId,
        unavailableMessage: this.homey.__('device_migrating'),
      });
      if (this.sessionId !== sessionId) return Promise.resolve(false);
      await this.restoreRenamedValues();
      await DeviceMigrator.migrateClass(this).catch((err) => this.error(err));

      let version = '0.0.0';
      try {
        version = this.homey.app.manifest.version;
      } catch {
      }
      MigrationNotice.noteUpdate(this.homey, this.getSettings().level);
      const labels = { level: version };
      if (BudgetSetup.has(this.driver.ds.driverId)) labels.budget_info = BudgetSetup.summary(this.homey, this.settings, this.driver.ds.driverId);
      if (this.settings.source_device_type === 'virtual via flow') labels.homey_device_name = this.homey.__('virtual_via_flow');
      await this.setSettings(labels).catch((err) => this.error(err));
      await SettingsView.update(this).catch((err) => this.error(err));
      this.settings = this.getSettings();
      this.migrating = false;
      return Promise.resolve(true);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
    }
  }

  async keepRenamedValues() {
    const renamed = Object.entries(this.driver.renamedCapsFor(this.getSettings()))
      .filter(([from, to]) => this.hasCapability(from) && !this.hasCapability(to));
    if (!renamed.length) return;
    const values = { ...(this.getStoreValue('renamedValues') || {}) };
    renamed.forEach(([from, to]) => {
      const value = this.getCapabilityValue(from);
      if (value !== null && value !== undefined) values[to] = value;
    });
    const oldCaps = [...new Set([...(this.getStoreValue('renamedCaps') || []), ...renamed.map(([from]) => from)])];
    this.log(`${this.getName()}: renamed capabilities`, renamed, values);
    await this.setStoreValue('renamedValues', values);
    await this.setStoreValue('renamedCaps', oldCaps);
  }

  async restoreRenamedValues() {
    const values = this.getStoreValue('renamedValues');
    if (!values) return;
    for (const [cap, value] of Object.entries(values)) {
      if (!this.hasCapability(cap)) return;
      if (this.getCapabilityValue(cap) === null) await this.setCapabilityValue(cap, value).catch((err) => this.error(err));
    }
    await this.unsetStoreValue('renamedValues').catch((err) => this.error(err));
  }

  async restoreHistory() {
    return ContractYear.serial(() => this.restoreHistoryNow());
  }

  async restoreHistoryNow() {
    let api = null;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    const ownNow = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (!api || typeof ownNow !== 'number') return;
    const starts = HistoryRestore.periodStarts(TimeHelpers.toLocalDate(new Date(), this.timeZone), this.startDay, this.startMonth, this.timeZone, this.contractStart);
    const cache = new Map();
    const ownAt = await this.sourceMeterAt(api, Math.min(...Object.values(starts).map(([prevMs]) => prevMs)), cache);
    if (!ownAt) return;
    const done = {};
    for (const period of Object.keys(starts)) {
      const [prevMs, startMs] = starts[period];
      const atStart = await ownAt(startMs).catch(() => null);
      if (typeof atStart !== 'number') continue;
      const key = `lastReading${period[0].toUpperCase()}${period.slice(1)}`;
      this[key] = MeterHelpers.getReadingObject(atStart, new Date(startMs), this.timeZone);
      await this.setStoreValue(key, this[key]);
      done[period] = Math.round((ownNow - atStart) * 10000) / 10000;
      const atPrev = await ownAt(prevMs).catch(() => null);
      const lastCap = this.ds.cmap[`last_${period}`];
      if (typeof atPrev === 'number' && lastCap) await this.setCapability(lastCap, Math.round((atStart - atPrev) * 10000) / 10000);
    }
    await this.restoreHistoryExtra(api, starts, cache).catch((err) => this.error(err));
    this.log(`${this.getName()}: history restored (since the period start)`, done);
  }

  async sourceMeterAt(api, oldestMs, cache = new Map()) {
    const s = this.getSettings();
    if (s.source_device_type !== 'Homey device' || s.homey_device_daily_reset || !s.homey_device_id) return null;
    const ownNow = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof ownNow !== 'number') return null;
    const sourceId = s.homey_device_id;
    if (s.use_measure_source) {
      const buckets = await HistoryRestore.powerBuckets(api, sourceId, oldestMs, this.sourceWattCap || 'measure_power');
      return async (ms) => {
        const kwh = HistoryRestore.energySince(buckets, ms);
        return typeof kwh === 'number' ? ownNow - kwh : null;
      };
    }
    const group = this.sourceCapGroup || {};
    const meters = this.lastGroupMeter || {};
    const roles = ['p1', 'p2', 'n1', 'n2'].filter((role) => group[role]);
    if (!roles.length || roles.some((role) => !Number.isFinite(meters[role]))) return null;
    return async (ms) => {
      const grown = await HistoryRestore.sourceGrowth(api, sourceId, group, meters, ms, cache);
      return typeof grown === 'number' ? ownNow - grown : null;
    };
  }

  historyMeterAt(api, oldestMs, cache = new Map()) {
    let source;
    return async (t) => {
      if (!api) return null;
      const own = await ContractYear.meterAt(api, this.getId(), this.ownMeterCaps(), t, { cache }).catch(() => null);
      if (typeof own === 'number') return own;
      if (source === undefined) source = await this.sourceMeterAt(api, oldestMs, cache).catch(() => null);
      return source ? source(t).catch(() => null) : null;
    };
  }

  async restoreHistoryExtra() {
    return undefined;
  }

  async followContract() {
    if (!this.lastReadingContract) this.lastReadingContract = this.getStoreValue('lastReadingContract') || null;
    const start = this.contractStart;
    if (start === (this.getStoreValue('contractPeriod') || null)) return;
    if (!start) {
      this.lastReadingContract = null;
      await this.unsetStoreValue('lastReadingContract');
      await this.unsetStoreValue('contractPeriod');
      if (this.meterMoney) delete this.meterMoney.contract;
      return;
    }
    if (this.lastReadingYear) {
      this.log(`${this.getName()}: contract start ${start}`);
      await ContractYear.serial(() => this.rebaseContract(start));
    }
    await this.setStoreValue('contractPeriod', start);
  }

  async keepYearAsContract() {
    const { cmap } = this.ds;
    if (!cmap.this_contract) return;
    this.lastReadingContract = { ...this.lastReadingYear };
    await this.setStoreValue('lastReadingContract', this.lastReadingContract);
    await this.setCapability(cmap.this_contract, this.getCapabilityValue(cmap.this_year));
    await this.setCapability(cmap.last_contract, this.getCapabilityValue(cmap.last_year));
    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities(cmap.meter_source);
    this.meterMoney.contract = this.getCapabilityValue('meter_money_this_year');
    this.meterMoney.lastContract = this.getCapabilityValue('meter_money_last_year');
    await this.setCapability('meter_money_this_contract', this.meterMoney.contract);
    await this.setCapability('meter_money_last_contract', this.meterMoney.lastContract);
    await this.setStoreValue('contractPeriod', this.contractStart);
  }

  async rebaseContract(start) {
    const { cmap } = this.ds;
    const now = this.getCapabilityValue(cmap.meter_source);
    if (!cmap.this_contract || typeof now !== 'number') return;
    let api = null;
    try {
      api = this.homey.app.api;
    } catch {
    }
    const starts = HistoryRestore.periodStarts(TimeHelpers.toLocalDate(new Date(), this.timeZone), 1, 0, this.timeZone, start);
    const [prevMs, ms] = starts.contract;
    const at = this.historyMeterAt(api, prevMs);
    const value = await at(ms);
    const prev = typeof value === 'number' ? await at(prevMs) : null;
    this.lastReadingContract = typeof value === 'number'
      ? MeterHelpers.getReadingObject(value, new Date(ms), this.timeZone) : MeterHelpers.getReadingObject(now, new Date(), this.timeZone);
    await this.setStoreValue('lastReadingContract', this.lastReadingContract);
    const kwh = now - this.lastReadingContract.meterValue;
    await this.setCapability(cmap.this_contract, kwh);
    await this.setCapability(cmap.last_contract, typeof prev === 'number' ? value - prev : null);
    await this.rebaseContractExtra(api, starts).catch((err) => this.error(err));
    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities(cmap.meter_source);
    this.meterMoney.contract = this.contractMoney();
    this.meterMoney.lastContract = null;
    await this.setCapability('meter_money_this_contract', this.meterMoney.contract);
    await this.setCapability('meter_money_last_contract', null);
    this.log(`${this.getName()}: contract year from ${typeof value === 'number' ? value.toFixed(3) : 'now'}`, { kwh, money: this.meterMoney.contract });
  }

  async rebaseContractExtra() {
    return null;
  }

  contractMoney() {
    if (!this.fixedMoney && this.getStoreValue('fixedMoney')) this.fixedMoney = this.getStoreValue('fixedMoney');
    const year = this.meterMoney && this.meterMoney.year;
    if (typeof year !== 'number' || !this.lastReadingYear || !this.lastReadingContract) return 0;
    const fixedYear = (this.fixedMoney && this.fixedMoney.year) || 0;
    const money = this.contractEnergyMoney(year - fixedYear) + this.fixedMoneySince(this.lastReadingContract);
    return Number.isFinite(money) ? money : 0;
  }

  contractEnergyMoney(yearEnergy) {
    const now = this.getCapabilityValue(this.ds.cmap.meter_source);
    const since = this.getStoreValue('moneySince');
    const kwh = (base) => (typeof since === 'number' && base.meterValue < since ? now - since : now - base.meterValue);
    const ratio = kwh(this.lastReadingContract) / kwh(this.lastReadingYear);
    return Number.isFinite(ratio) && ratio >= 0 ? yearEnergy * ratio : 0;
  }

  async ensureValidSettings() {
    return undefined;
  }

  getCurrencyUnit() {
    if (this.driver.ds && (this.driver.ds.driverId === 'gas' || this.driver.ds.driverId === 'water')) return 'm³';
    return 'kWh';
  }

  onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
    if (this.shouldUpdateCurrencyOnAdd()) this.currencyChanged = true;

    if (this.driver.updateDeviceTariff) {
      this.homey.setTimeout(() => {
        if (!this.isDestroyed) this.driver.updateDeviceTariff(this).catch((err) => this.error(err));
      }, 3000);
    }
  }

  shouldUpdateCurrencyOnAdd() {
    return false;
  }

  onDeleted() {
    this.stopPolling();
    this.destroyListeners();
    FileStore.remove(this).catch(() => {});
    this.log(`Meter deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Meter renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (EnergyExclude.onlyHomeyEnergy(changedKeys)) return undefined;
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (changedKeys.includes('budget')) {
      const reason = Budget.invalidReason(newSettings.distribution || this.settings.distribution, newSettings.budget);
      if (reason) throw Error(this.homey.__(reason));
    }

    if (BUDGET_KEYS.some((key) => changedKeys.includes(key))) {
      this.migrated = false;
    }

    if (changedKeys.includes('decimals_meter')) {
      this.meterDecimalsChanged = true;
    }

    if (changedKeys.includes('tariff_update_group')) this.tariffGroupChanged = true;

    this.homey.setTimeout(() => {
      this.restartDevice(5000).catch((error) => this.error(error));
    }, 0);
    return Promise.resolve(true);
  }

  async onSourceChanged() {
    await this.setStoreValue('pollSource', null);
  }

  async updateSourceLabel() {
    if (this.settings.source_device_type !== 'Homey device') return;
    let text = this.settings.use_measure_source
      ? `${this.sourceWattCap || 'measure_power'} (W)`
      : Object.values(this.sourceCapGroup || {}).filter(Boolean).join(', ');
    if (!text) return;
    if (this.getStoreValue('pollSource')) text += ` (${this.homey.__('source_polled')})`;
    if (text !== this.getSettings().source_capability) await this.setSettings({ source_capability: text });
  }

  deviceWarning() {
    const { setup } = this.driver.ds;
    return PriceDrivers.priceWarning(this.homey, (setup && setup.prices) || 'power', this.getSettings().tariff_update_group,
      !!(setup && setup.requirePrice));
  }

  async checkPriceSetup() {
    await FlowScan.tariffFlowGroups(this.homey).catch(() => null);
    if (await this.moveToFixedTariff()) return;
    await this.updateWarning();
  }

  async moveToFixedTariff() {
    if (this.getStoreValue('fixedTariffChecked')) return false;
    const { setup } = this.driver.ds;
    if (!setup || !setup.requirePrice || !(setup.settings || []).includes('tariff')) return false;
    if (!PriceDrivers.tariffScanState(this.homey).result) return false;
    const settings = this.getSettings();
    const group = Number(settings.tariff_update_group);
    const commodity = setup.prices || 'power';
    const fed = !group || typeof settings.tariff !== 'number'
      || PriceDrivers.getDevices(this.homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === group)
      || PriceDrivers.flowFed(this.homey, commodity, group);
    await this.setStoreValue('fixedTariffChecked', true);
    if (fed) return false;
    this.log(`No price device or flow in tariff group ${group}: fixed tariff (group 0) from now on`);
    await this.setSettings({ tariff_update_group: 0 });
    this.tariffGroupChanged = true;
    this.restartDevice(1000).catch((err) => this.error(err));
    return true;
  }

  async updateWarning() {
    const warning = this.deviceWarning();
    if (warning === this.warningShown) return;
    if (warning) await this.setWarning(warning);
    else await this.unsetWarning();
    this.warningShown = warning;
  }

  fixValues() {
    const kinds = [];
    const meterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof meterValue === 'number' && this.lastReadingDay && this.lastReadingMonth && this.lastReadingYear) {
      const unit = FixValues.unitOf(this, this.ds.cmap.this_day);
      kinds.push({
        id: 'totals',
        label: this.homey.__('repair.fix_totals'),
        info: this.homey.__('repair.fix_totals_info'),
        fields: this.totalIds()
          .map((id) => FixValues.field(this, id, this.getCapabilityValue(this.ds.cmap[FixValues.TOTALS[id]]), unit, 4)),
      });
    }
    const money = FixValues.moneyKind(this);
    if (money) kinds.push(money);
    return { kinds };
  }

  async applyFixValues({ kind, values } = {}) {
    if (kind === 'totals') return this.fixTotals(FixValues.parse(this, values, this.totalIds()));
    if (kind === 'money') return this.fixMoney(FixValues.parse(this, values, Object.keys(FixValues.MONEY)));
    throw Error(this.homey.__('error_device_corrupt'));
  }

  totalIds() {
    return ['day', 'month', 'year', ...(this.contractStart && this.lastReadingContract ? ['contract', 'lastContract'] : [])];
  }

  async fixTotals(totals) {
    const meterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof meterValue !== 'number' || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear) {
      throw Error(this.homey.__('error_device_corrupt'));
    }
    const direction = this.countingDirection(
      meterValue,
      meterValue - this.lastReadingYear.meterValue,
      meterValue - this.lastReadingMonth.meterValue,
    ) < 0 ? -1 : 1;
    if (Object.values(totals).some((total) => total * direction < 0)) throw Error(this.homey.__('error_total_invalid'));
    for (const [id, total] of Object.entries(totals)) {
      const key = MeterHelpers.READING_KEYS.find((k) => k === `lastReading${id[0].toUpperCase()}${id.slice(1)}`);
      if (!key) {
        await this.setCapability(this.ds.cmap[FixValues.TOTALS[id]], total).catch((err) => this.error(err));
        continue;
      }
      this[key] = { ...this[key], meterValue: meterValue - total };
      await this.setStoreValue(key, this[key]);
      await this.setCapability(this.ds.cmap[`this_${id}`], total).catch((err) => this.error(err));
    }
    await this.updateAvgMoney().catch((err) => this.error(err));
    this.log(`${this.getName()} period totals fixed in repair`, totals);
  }

  async fixMoney(values) {
    if (!this.meterMoney) throw Error(this.homey.__('error_device_corrupt'));
    const money = { ...this.meterMoney, ...values };
    if (values.month !== undefined || values.year !== undefined) {
      const estimate = this.estimateFixedMoney();
      const reseed = (value, est) => {
        if (value === 0) return 0;
        return value > 0 ? Math.min(est, value) : est;
      };
      const fixed = { ...(this.fixedMoney || { month: 0, year: 0 }) };
      if (values.month !== undefined) fixed.month = reseed(money.month, estimate.month);
      if (values.year !== undefined) fixed.year = reseed(money.year, estimate.year);
      this.fixedMoney = fixed;
      await this.setStoreValue('fixedMoney', fixed).catch((err) => this.error(err));
    }
    this.meterMoney = money;
    for (const [id, cap] of Object.entries(FixValues.MONEY)) {
      if (values[id] !== undefined) await this.setCapability(cap, money[id]);
    }
    await this.updateAvgMoney().catch((err) => this.error(err));
    this.log(`${this.getName()} money fixed in repair`, values);
  }

  usesRealtimePower() {
    return true;
  }

  async addSourceCapGroup() {
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {};
    this.sourceCapGroup = this.driver.sourceCapGroupFor(this.sourceDevice, this.getStoreValue('sourceCaps'));
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible meter capabilities ${this.sourceDevice.capabilities}`);
    }
    this.log(`${this.sourceDevice.name} source capability group:`, JSON.stringify(this.sourceCapGroup));
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    const meterCap = this.ds.cmap.meter_source;
    const targetMeasureCap = this.ds.cmap.measure_source;

    if (this.getSettings().use_measure_source) {
      this.sourceWattCap = this.driver.wattCapFor
        ? this.driver.wattCapFor(this.sourceDevice, this.getStoreValue('sourceCaps')) : 'measure_power';
      if (this.sourceWattCap && this.sourceDevice.capabilities.includes(this.sourceWattCap)) {
        this.log(`registering ${this.sourceWattCap} capability listener for ${this.sourceDevice.name}`);
        this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance(this.sourceWattCap, async (value) => {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          if (typeof value === 'number' && this.lastMinMax && this.lastMinMax.reading) {
            await this.checkMinMax(value, this.lastMinMax.reading).catch(this.error);
          }
          await this.updateMeterFromMeasure(value).catch(this.error);
        });
        return;
      }
      throw Error(`${this.sourceDevice.name} has no measure_power capability ${this.sourceDevice.capabilities}`);
    }

    await this.addSourceCapGroup();
    this.listenStartTm = Date.now();
    this.log(`registering ${meterCap} capability listener for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          this.lastListenerTm = Date.now();
          this.lastGroupMeter[key] = value;
          await this.updateGroupMeter().catch(this.error);
        });
      }
    });

    if (this.usesRealtimePower() && this.sourceDevice.capabilities.includes('measure_power')) {
      this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
        if (typeof value === 'number') {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          if (this.lastMinMax && this.lastMinMax.reading) {
            await this.checkMinMax(value, this.lastMinMax.reading).catch(this.error);
          }
        }
      });
    }
  }

  async pollMeter() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;

    if (this.getSettings().source_device_type.includes('Homey Energy')) {
      const report = await api.energy.getLiveReport().catch(this.error);
      if (report && this.settings.homey_energy && report[this.settings.homey_energy]) {
        const value = report[this.settings.homey_energy].W;
        await this.updateMeterFromMeasure(value).catch(this.error);
      }
      return;
    }

    if (!this.sourceCapGroup) await this.addSourceCapGroup();

    await this.getSourceDevice();
    const source = await SourceDeviceHelper.getSourceDevice(this, { fresh: true }).catch(() => this.sourceDevice);
    let missed = false;
    Object.keys(this.sourceCapGroup)
      .filter((k) => this.sourceCapGroup[k])
      .forEach((k) => {
        if (source.capabilitiesObj && source.capabilitiesObj[this.sourceCapGroup[k]]) {
          const { value } = source.capabilitiesObj[this.sourceCapGroup[k]];
          if (Number.isFinite(this.lastGroupMeter[k]) && Number.isFinite(value) && value !== this.lastGroupMeter[k]) missed = true;
          this.lastGroupMeter[k] = value;
        }
      });
    const silentMs = Date.now() - (this.lastListenerTm || this.listenStartTm || Date.now());
    if (missed && silentMs > SILENT_LISTENER_MS && !this.intervalIdDevicePoll && this.listenStartTm) {
      this.log(`${this.getName()}: no listener updates for ${Math.round(silentMs / 60000)} minutes, polling the source every minute`);
      await this.setStoreValue('pollSource', true).catch((err) => this.error(err));
      this.startPolling(1);
      await this.updateSourceLabel().catch((err) => this.error(err));
    }
    this.lastGroupMeterReady = true;
    await this.updateGroupMeter().catch(this.error);

    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.usesRealtimePower() && source.capabilitiesObj && source.capabilitiesObj.measure_power) {
      const rtValue = source.capabilitiesObj.measure_power.value;
      if (typeof rtValue === 'number') {
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        if (this.lastMinMax && this.lastMinMax.reading) {
          await this.checkMinMax(rtValue, this.lastMinMax.reading).catch(this.error);
        }
      }
    }
  }

  async updateGroupMeter() {
    if (!this.lastGroupMeterReady) {
      this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
      return;
    }
    let total = 0;
    let hasValue = false;
    if (Number.isFinite(this.lastGroupMeter.p1)) {
      total += this.lastGroupMeter.p1; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.p2)) {
      total += this.lastGroupMeter.p2; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.n1)) {
      total -= this.lastGroupMeter.n1; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.n2)) {
      total -= this.lastGroupMeter.n2; hasValue = true;
    }
    if (hasValue) await this.updateMeter(total).catch(this.error);
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    if (this.intervalIdDevicePoll) {
      this.homey.clearInterval(this.intervalIdDevicePoll);
      this.homey.clearTimeout(this.intervalIdDevicePoll);
      this.intervalIdDevicePoll = null;
    }
  }

  startPolling(interval) {
    this.stopPolling();
    if (this.isDestroyed) return;
    this.log(`start polling ${this.getName()} @${interval} minutes interval`);
    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        await this.pollMeter();
      } catch (error) {
        this.error(error);
        this.setUnavailable(error.message || this.homey.__('polling_failed')).catch((err) => this.error(err));
        this.initReady = false;
      } finally {
        if (!this.isDestroyed) {
          this.intervalIdDevicePoll = this.homey.setTimeout(() => {
            poll().catch(this.error);
          }, 1000 * 60 * interval);
        }
      }
    };
    poll().catch(this.error);
  }

  async initDeviceValues() {
    if (!this.available) this.setAvailable().catch(this.error);
    this.log(`${this.getName()} Restoring device values after init`);

    if (!this.tariffHistory) this.tariffHistory = await this.getStoreValue('tariffHistory');
    if (!this.tariffHistory) {
      const start = typeof this.settings.tariff === 'number' ? this.settings.tariff : 0;
      this.tariffHistory = {
        previous: null,
        previousTm: null,
        previousExport: null,
        current: start,
        currentExport: start,
        currentTm: new Date(),
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory);
    }
    if (!this.priceInterval) this.priceInterval = await this.getStoreValue('priceInterval') || 60;
    await this.applyFixedTariff();

    if (!this.newReadings) this.newReadings = [];

    await this.followPeriodStarts();

    this.budgets = this.getBudgets();

    if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
    if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
    if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

    if (!this.dayStartCumVal) this.dayStartCumVal = (this.lastReadingDay && this.lastReadingDay.meterValue) || 0;
    if (!this.cumVal) this.cumVal = this.dayStartCumVal;
    if (!this.lastAbsVal) this.lastAbsVal = 0;

    if (!this.lastMinMax) this.lastMinMax = await this.getStoreValue('lastMinMax');
    if (this.lastMinMax && this.lastMinMax.reading && this.ensureMinMaxShape(this.lastMinMax.reading)) {
      this.log(`${this.getName()}: migrated stored lastMinMax to the day/month/year shape`);
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }

    const meterX = this.getCapabilityValue(this.ds.cmap.meter_source);
    if ((this.settings.use_measure_source || this.settings.homey_energy) && typeof meterX !== 'number') {
      this.log('meter kWh is set to 0 after device pair');
      await this.setCapability(this.ds.cmap.meter_source, 0);
    }

    if (!this.lastMeasure) {
      this.lastMeasure = {
        value: this.getCapabilityValue(this.ds.cmap.measure_source),
        measureTm: (this.lastMinMax && this.lastMinMax.reading) ? new Date(this.lastMinMax.reading.meterTm) : new Date(),
      };
      if (typeof this.lastMeasure.value !== 'number') this.lastMeasure.value = 0;
    }
    if ((new Date() - new Date(this.lastMeasure.measureTm)) > 300000) this.lastMeasure.value = 0;

    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities(this.ds.cmap.meter_source);

    if (!this.fixedMoney) {
      this.fixedMoney = await this.getStoreValue('fixedMoney');
      if (!this.fixedMoney) {
        this.fixedMoney = this.estimateFixedMoney();
        await this.setStoreValue('fixedMoney', this.fixedMoney).catch((err) => this.error(err));
      }
    }
  }

  fixedMoneySince(reading) {
    const { markup_hour: hour = 0, markup_day: day = 0, markup_month: month = 0 } = this.getSettings();
    const nowMs = Date.now();
    const nowLocal = TimeHelpers.toLocalDate(new Date(nowMs), this.timeZone);
    const localDayNr = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * 60 * 60 * 1000);
    const startOf = (d) => MeterHelpers.monthStartDay(this.startDay, d.getFullYear(), d.getMonth());
    const billingMonthNr = (d) => (d.getFullYear() * 12) + d.getMonth() - (d.getDate() < startOf(d) ? 1 : 0);
    const fromMs = reading ? new Date(reading.meterTm).getTime() : NaN;
    if (!Number.isFinite(fromMs) || fromMs > nowMs) return 0;
    const fromLocal = TimeHelpers.toLocalDate(new Date(fromMs), this.timeZone);
    const opened = (fromLocal.getDate() === startOf(fromLocal) && fromLocal.getHours() === 0) ? 1 : 0;
    const hours = Math.floor(nowMs / 3600000) - Math.floor(fromMs / 3600000) + opened;
    const days = localDayNr(nowLocal) - localDayNr(fromLocal) + opened;
    const months = billingMonthNr(nowLocal) - billingMonthNr(fromLocal) + opened;
    return Math.max(0, (month * months) + (day * days) + (hour * hours));
  }

  estimateFixedMoney() {
    return {
      month: this.fixedMoneySince(this.lastReadingMonth),
      year: this.fixedMoneySince(this.lastReadingYear),
    };
  }

  async initFirstReading({ ...reading }) {
    const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
    if (pairInit) {
      this.log(`${this.getName()} Setting values after pair init`);
      await this.setStoreValue('lastReadingHour', reading);
      this.lastReadingHour = reading;
      const dayStart = this.settings.homey_device_daily_reset ? await this.getReadingObject(0) : reading;
      await this.setStoreValue('lastReadingDay', dayStart);
      this.lastReadingDay = dayStart;
      await this.setStoreValue('lastReadingMonth', reading);
      this.lastReadingMonth = reading;
      await this.setStoreValue('lastReadingYear', reading);
      this.lastReadingYear = reading;
      if (this.contractStart) {
        await this.setStoreValue('lastReadingContract', reading);
        this.lastReadingContract = reading;
      }
      await this.setStoreValue('moneySince', reading.meterValue);
      this.homey.setTimeout(() => {
        this.restoreHistory().catch((err) => this.error(err));
      }, 0);
    }
    if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
    if (this.ensureMinMaxShape(reading)) {
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }
    this.initReady = true;
    this.firstReadingDone = true;
  }

  async applyFixedTariff() {
    const { tariff } = this.settings;
    const hasExport = this.driver.ds.setup && (this.driver.ds.setup.settings || []).includes('tariff_export');
    if (hasExport && this.getStoreValue('fixedExport') === null) {
      if (typeof tariff === 'number') {
        await this.setSettings({ tariff_export: tariff }).catch((err) => this.error(err));
        this.settings = this.getSettings();
      }
      await this.setStoreValue('fixedExport', true);
    }
    if (Number(this.settings.tariff_update_group) || typeof tariff !== 'number') return;
    const exportTariff = hasExport && typeof this.settings.tariff_export === 'number' ? this.settings.tariff_export : tariff;
    if (this.tariffHistory.current === tariff && this.tariffHistory.currentExport === exportTariff) return;
    await this.updateTariffHistory(tariff, new Date(), this.priceInterval, exportTariff);
  }

  async updateTariffHistory(tariff, currentTm, priceInterval, exportTariff, args) {
    try {
      if (!this.migrated || !this.tariffHistory) {
        this.log('device is not ready. Ignoring new tariff!');
        return;
      }
      await PairSetup.updatePriceInfo(this).catch((err) => this.error(err));
      this.priceInterval = priceInterval || 60;
      const exportT = exportTariff !== undefined ? exportTariff : tariff;

      let crossedBoundary = true;
      if (this.tariffHistory && this.tariffHistory.currentTm) {
        const lastTm = new Date(this.tariffHistory.currentTm);
        const pInt = this.priceInterval;
        const lastBoundary = MeterHelpers.startOfBlock(lastTm, pInt, this.timeZone);
        const currentBoundary = MeterHelpers.startOfBlock(new Date(currentTm), pInt, this.timeZone);
        crossedBoundary = currentBoundary > lastBoundary;
      }

      const prevExpCrossed = this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : this.tariffHistory.current;
      const prevExpNotCrossed = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : this.tariffHistory.previous;
      const prevExp = crossedBoundary ? prevExpCrossed : prevExpNotCrossed;

      const tariffHistory = {
        previous: crossedBoundary ? this.tariffHistory.current : this.tariffHistory.previous,
        previousExport: prevExp,
        previousTm: crossedBoundary ? this.tariffHistory.currentTm : this.tariffHistory.previousTm,
        current: tariff,
        currentExport: exportT,
        currentTm,
      };
      this.tariffHistory = tariffHistory;
      const activeTariff = this.getActiveTariff({ meterValue: this.meterMoney?.meterValue || 0 }, tariff, exportT);
      await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));
      await this.setStoreValue('tariffHistory', tariffHistory);
      await this.setStoreValue('priceInterval', this.priceInterval).catch((err) => this.error(err));

      const moneyUnit = MoneyUnit.fromPrices(args);
      if (await MoneyUnit.take(this, moneyUnit, '¤')) {
        this.log('Currency from the price device:', moneyUnit);
        this.currencyChanged = true;
        await SettingsView.update(this).catch((err) => this.error(err));
        this.homey.setTimeout(() => {
          this.restartDevice(2000).catch(this.error);
        }, 0);
      }
    } catch (error) {
      this.error(error);
    }
  }

  async checkMeterJump(value) {
    const GROSS_JUMP = 10000;
    const IMPOSSIBLE_METER = 1e7;

    if (!Number.isFinite(value) || Math.abs(value) > IMPOSSIBLE_METER) {
      this.pendingAnomaly = null;
      throw Error(`ignoring impossible incoming meter value! ${value}`);
    }

    const lastVal = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (lastVal === null || !Number.isFinite(lastVal) || !(Math.abs(lastVal) > 1)) {
      this.pendingAnomaly = null;
      return;
    }
    if (Math.abs(lastVal) > IMPOSSIBLE_METER) {
      this.pendingAnomaly = null;
      this.log(`${this.getName()}: stored meter value ${lastVal} is impossible. Re-anchoring baselines to ${value}.`);
      await this.reanchorBaselines(value);
      return;
    }
    const meterDelta = Math.abs(value - lastVal);
    const anomalyJump = this.anomalyCeiling();
    if (meterDelta > anomalyJump || meterDelta > GROSS_JUMP) {
      const needed = meterDelta > GROSS_JUMP ? 3 : 2;
      const { pendingAnomaly } = this;
      if (pendingAnomaly && Math.abs(value - pendingAnomaly.value) <= anomalyJump) {
        const seen = pendingAnomaly.seen + 1;
        if (seen >= needed) {
          this.pendingAnomaly = null;
          this.log(`${this.getName()}: meter jump confirmed (${meterDelta.toFixed(2)}) by ${seen} consistent readings. Re-anchoring baselines to ${value}.`);
          await this.reanchorBaselines(value);
          return;
        }
        this.pendingAnomaly = { value, seen };
        throw Error(`holding anomalous meter value pending confirmation (${seen}/${needed}): ${value} (prev: ${lastVal})`);
      }
      this.pendingAnomaly = { value, seen: 1 };
      throw Error(`holding anomalous meter value pending confirmation (1/${needed}): ${value} (prev: ${lastVal})`);
    }

    this.pendingAnomaly = null;
  }

  countingDirection(meterValue, valYear, valMonth) {
    const MIN_TREND = 1;
    if (Math.abs(valYear) >= MIN_TREND) return Math.sign(valYear);
    if (Math.abs(valMonth) >= MIN_TREND) return Math.sign(valMonth);
    return meterValue < 0 ? -1 : 1;
  }

  anomalyCeiling() {
    const RATIO = 20;
    const FLOOR = 1;
    const lastHour = this.getCapabilityValue(this.ds.cmap.last_hour);
    const lastDay = this.getCapabilityValue(this.ds.cmap.last_day);
    const reference = Math.max(
      typeof lastHour === 'number' ? Math.abs(lastHour) : 0,
      typeof lastDay === 'number' ? Math.abs(lastDay) : 0,
    );
    return Math.max(FLOOR, reference * RATIO);
  }

  async continueFromNewSource(value) {
    this.shiftNextReading = false;
    this.pendingAnomaly = null;
    const last = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (!Number.isFinite(last) || !this.lastReadingYear) return;
    this.log(`${this.getName()}: source switched (${last} -> ${value}), totals continue`);
    await MeterHelpers.shiftBaselines(this, value - last);
    await this.setCapability(this.ds.cmap.meter_source, value).catch((err) => this.error(err));
  }

  async reanchorBaselines(meterValue) {
    await Promise.all(MeterHelpers.READING_KEYS.map(async (key) => {
      if (this[key]) {
        this[key] = { ...this[key], meterValue };
        await this.setStoreValue(key, this[key]).catch((err) => this.error(err));
      }
    }));
    if (this.meterMoney) this.meterMoney.meterValue = meterValue;
    await this.reanchorExtraBaselines(meterValue).catch((err) => this.error(err));
  }

  async reanchorExtraBaselines() {
    return null;
  }

  async handleUpdateMeter(reading) {
    try {
      const periods = this.getPeriods(reading);
      await this.updateMeters(reading, periods);
      await this.updateTargets(periods);
      await this.updateMoney(reading, periods);
      await this.updateAvgMoney(periods);
      await this.updateMeasureMinMax(reading, periods);
    } catch (error) {
      this.error(error);
    }
  }

  async updateMeter(val, { selfPoll = false } = {}) {
    try {
      if (typeof val !== 'number') {
        this.log(`Ignoring invalid meter value: ${val} (${typeof val})`);
        return;
      }
      if (!this.migrated || this.currencyChanged) return;
      let value = val;
      if (!selfPoll && this.settings.homey_device_daily_reset) {
        const absVal = Math.abs(value);
        const reset = ((absVal < this.lastAbsVal) && (absVal < 0.1));
        this.lastAbsVal = absVal;
        if (reset) {
          this.log('source device meter reset detected');
          this.dayStartCumVal = this.cumVal;
          this.cumVal += absVal;
        } else {
          this.cumVal = this.dayStartCumVal + absVal;
        }
        value = this.cumVal;
      }

      if (!selfPoll && this.shiftNextReading) await this.continueFromNewSource(value);
      if (!selfPoll) await this.checkMeterJump(value);

      const reading = await this.getReadingObject(value);
      if (!this.firstReadingDone || !this.lastReadingYear) await this.initFirstReading(reading);
      if (!this.newReadings) this.newReadings = [];
      this.newReadings.push(reading);

      if (this.processingReadings) return;
      this.processingReadings = true;
      try {
        while (this.newReadings.length > 0) {
          const newReading = this.newReadings.shift();
          await this.handleUpdateMeter(newReading);
        }
      } finally {
        this.processingReadings = false;
      }
    } catch (error) {
      this.error(error);
    }
  }

  async send_meter(args) {
    if (this.getSettings().source_device_type !== 'virtual via flow') throw Error(this.homey.__('error_device_not_found'));
    await this.updateMeterFromFlow(args);
  }

  async updateMeterFromFlow(args) {
    if (!this.migrated || this.currencyChanged) return;
    let value = null;
    if (args && args.value !== undefined) value = args.value;
    else if (typeof args === 'number') value = args;

    const selfPoll = (value === null);
    if (selfPoll) {
      value = this.getCapabilityValue(this.ds.cmap.meter_source);
      if (value === null) return;
    }
    await this.updateMeter(value, { selfPoll });
  }

  async updateMeterFromMeasure(val) {
    if (!this.migrated || this.currencyChanged) return;
    const measureTm = new Date();
    let value = val;
    if (value === null && !this.settings.source_device_type.includes('Homey Energy')) {
      const cap = this.sourceWattCap || 'measure_power';
      if (this.sourceDevice && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[cap]) {
        value = this.sourceDevice.capabilitiesObj[cap].value;
      }
    }
    if (typeof value !== 'number') return;
    const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);

    const lastMeterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof lastMeterValue !== 'number') {
      this.error('lastMeterValue is NaN, WTF');
      return;
    }
    if (typeof deltaTm !== 'number' || deltaTm === 0) {
      this.error('deltaTm is NaN, WTF');
      return;
    }
    const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
    const meter = lastMeterValue + deltaMeter;
    this.lastMeasure = {
      value,
      measureTm,
    };
    await this.updateMeter(meter);
  }

  getPeriods(reading) {
    return {
      ...MeterHelpers.getPeriods(
        reading,
        this.lastReadingHour,
        this.lastReadingDay,
        this.lastReadingMonth,
        this.lastReadingYear,
        this.startDay,
        this.startMonth,
      ),
      newContract: ContractYear.isNewContract(reading, this.lastReadingContract, this.contractStart),
    };
  }

  getBudgets() {
    const local = Budget.localKind(this.driver.ds.driverId);
    return Budget.getBudgetsToDate({
      distribution: this.settings.distribution,
      budget: this.settings.budget,
      profile: this.localProfile,
      fallback: local && local.fallback,
      timeZone: this.timeZone,
      startDay: this.startDay,
      startMonth: this.startMonth,
    });
  }

  async loadLocalProfile() {
    if (this.settings.distribution !== 'local' || !Budget.isActive('local', this.settings.budget)) return;
    this.localProfile = await BudgetSetup.localProfile(this.homey, this.driver.ds.driverId, this.settings);
    if (this.localProfile) this.log(`Local budget profile: ${this.localProfile.map((v) => (v * 100).toFixed(1)).join(' ')}`);
    this.budgets = this.getBudgets();
  }

  async updateMeters({ ...reading }, { ...periods }) {
    await this.setCapability(this.ds.cmap.meter_source, reading.meterValue).catch((err) => this.error(err));
    let lastReadingHour = { ...this.lastReadingHour };
    let lastReadingDay = { ...this.lastReadingDay };
    let lastReadingMonth = { ...this.lastReadingMonth };
    let lastReadingYear = { ...this.lastReadingYear };
    let valHour = reading.meterValue - lastReadingHour.meterValue;
    let valDay = reading.meterValue - lastReadingDay.meterValue;
    let valMonth = reading.meterValue - lastReadingMonth.meterValue;
    let valYear = reading.meterValue - lastReadingYear.meterValue;

    const lastHourRef = this.getCapabilityValue(this.ds.cmap.last_hour);
    const lastDayRef = this.getCapabilityValue(this.ds.cmap.last_day);
    const hasHistory = typeof lastHourRef === 'number' || typeof lastDayRef === 'number';
    const ceiling = hasHistory ? this.anomalyCeiling() : Infinity;
    const direction = this.countingDirection(reading.meterValue, valYear, valMonth);
    if (valHour * direction < -ceiling) {
      this.log(`${this.getName()}: implausible hour total (${valHour.toFixed(3)}) - re-anchoring baseline`);
      lastReadingHour = reading; valHour = 0;
      this.lastReadingHour = lastReadingHour;
      await this.setStoreValue('lastReadingHour', lastReadingHour).catch((err) => this.error(err));
    }
    if (valDay * direction < -ceiling) {
      this.log(`${this.getName()}: implausible day total (${valDay.toFixed(3)}) - re-anchoring baseline`);
      lastReadingDay = reading; valDay = 0;
      this.lastReadingDay = lastReadingDay;
      await this.setStoreValue('lastReadingDay', lastReadingDay).catch((err) => this.error(err));
    }

    if (periods.newHour) {
      await this.setCapability(this.ds.cmap.last_hour, valHour).catch((err) => this.error(err));
      lastReadingHour = reading;
      await this.setStoreValue('lastReadingHour', reading);
      valHour = 0;
    }
    if (periods.newDay) {
      await this.setCapability(this.ds.cmap.last_day, valDay).catch((err) => this.error(err));
      lastReadingDay = reading;
      await this.setStoreValue('lastReadingDay', reading);
      valDay = 0;
    }
    if (periods.newMonth) {
      await this.setCapability(this.ds.cmap.last_month, valMonth).catch((err) => this.error(err));
      lastReadingMonth = reading;
      await this.setStoreValue('lastReadingMonth', reading);
      valMonth = 0;
    }
    if (periods.newYear) {
      await this.setCapability(this.ds.cmap.last_year, valYear).catch((err) => this.error(err));
      lastReadingYear = reading;
      await this.setStoreValue('lastReadingYear', reading);
      valYear = 0;
    }

    await this.setCapability(this.ds.cmap.this_hour, valHour).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_day, valDay).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_month, valMonth).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_year, valYear).catch((err) => this.error(err));
    await this.updateContractMeter(reading, periods).catch((err) => this.error(err));
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
  }

  async updateContractMeter(reading, periods) {
    if (!this.contractStart || !this.ds.cmap.this_contract) return;
    if (!this.lastReadingContract) {
      this.lastReadingContract = reading;
      await this.setStoreValue('lastReadingContract', reading);
    }
    let val = reading.meterValue - this.lastReadingContract.meterValue;
    if (periods.newContract) {
      await this.setCapability(this.ds.cmap.last_contract, val);
      this.lastReadingContract = reading;
      await this.setStoreValue('lastReadingContract', reading);
      val = 0;
    }
    await this.setCapability(this.ds.cmap.this_contract, val);
  }

  async updateTargets({ ...periods }) {
    if (!Budget.isActive(this.settings.distribution, this.settings.budget)) return;
    if (periods.newDay) this.budgets = this.getBudgets();
    if (this.budgets && this.budgets.yearToDate) {
      const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_year) / this.budgets.yearToDate);
      await this.setCapability('meter_target_year_to_date', onTarget).catch((err) => this.error(err));
    }
    if (this.budgets && this.budgets.monthToDate) {
      const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_month) / this.budgets.monthToDate);
      await this.setCapability('meter_target_month_to_date', onTarget).catch((err) => this.error(err));
    }
  }

  getActiveTariff(reading, tariff, exportTariff) {
    let deltaMeter;
    if (this.meterMoney && typeof this.meterMoney.meterValue === 'number' && typeof reading.meterValue === 'number') {
      deltaMeter = reading.meterValue - this.meterMoney.meterValue;
    }
    return MeterHelpers.getActiveTariff(
      this.getSettings(),
      this.currentGridPower,
      tariff,
      exportTariff,
      deltaMeter,
    );
  }

  async getMoneyDeltaOverride() {
    return null;
  }

  async updateMoney({ ...reading }, { ...periods }) {
    const priceInterval = this.priceInterval || 60;
    const lastReadingTm = this.lastMoneyReadingTm || new Date(new Date(reading.meterTm).getTime() - 1000);
    const { tariff, exportTariff } = MeterHelpers.getPeriodTariff(this.tariffHistory, priceInterval, reading.meterTm, lastReadingTm, undefined, this.timeZone);

    this.lastMoneyReadingTm = reading.meterTm;

    const safeExportTariff = exportTariff !== undefined && exportTariff !== null ? exportTariff : tariff;

    const activeTariff = this.getActiveTariff(reading, tariff, safeExportTariff);

    const { current, currentExport } = this.tariffHistory;
    const nowTariff = this.getActiveTariff(reading, current, typeof currentExport === 'number' ? currentExport : current);
    if (nowTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', nowTariff).catch((err) => this.error(err));

    const deltaMoneyOverride = await this.getMoneyDeltaOverride(reading, periods);
    if (this.contractStart && typeof this.meterMoney.contract !== 'number') this.meterMoney.contract = 0;
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff, deltaMoneyOverride);

    const settings = this.getSettings();
    const rolled = await this.rollMoneyPeriods(meterMoney, periods);
    const fixedMarkup = rolled.reduce((sum, name) => sum + (settings[`markup_${name}`] || 0), 0);
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;
    if (typeof meterMoney.contract === 'number') meterMoney.contract += fixedMarkup;
    if (periods.newHour || periods.newDay || periods.newMonth || periods.newYear) {
      const fixed = { ...(this.fixedMoney || { month: 0, year: 0 }) };
      if (periods.newMonth) fixed.month = 0;
      if (periods.newYear) fixed.year = 0;
      fixed.month += fixedMarkup;
      fixed.year += fixedMarkup;
      this.fixedMoney = fixed;
      await this.setStoreValue('fixedMoney', fixed).catch((err) => this.error(err));
    }
    await this.setCapability('meter_money_this_hour', meterMoney.hour);
    await this.setCapability('meter_money_this_day', meterMoney.day);
    await this.setCapability('meter_money_this_month', meterMoney.month);
    await this.setCapability('meter_money_this_year', meterMoney.year);
    if (typeof meterMoney.contract === 'number') await this.setCapability('meter_money_this_contract', meterMoney.contract);
    this.meterMoney = meterMoney;
  }

  meterForMoney(cap, base) {
    const meter = this.getCapabilityValue(cap);
    const since = this.getStoreValue('moneySince');
    const now = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof since !== 'number' || typeof now !== 'number' || !base || base.meterValue >= since) return meter;
    return now - since;
  }

  async updateAvgMoney() {
    const fixed = this.fixedMoney || { month: 0, year: 0 };
    const moneyThisMonth = this.meterMoney.month - fixed.month;
    const meterThisMonth = this.meterForMoney(this.ds.cmap.this_month, this.lastReadingMonth);
    if (meterThisMonth) await this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth).catch((err) => this.error(err));

    const moneyThisYear = this.meterMoney.year - fixed.year;
    const meterThisYear = this.meterForMoney(this.ds.cmap.this_year, this.lastReadingYear);
    if (meterThisYear) await this.setCapability('meter_money_this_year_avg', moneyThisYear / meterThisYear).catch((err) => this.error(err));
  }

  async updateMeasureMinMax({ ...reading }) {
    const deltaTm = new Date(reading.meterTm) - new Date(this.lastMinMax.reading.meterTm);
    const deltaMeter = reading.meterValue - this.lastMinMax.reading.meterValue;

    if (this.capabilityInstances && (this.capabilityInstances.measurePowerRealtime || this.capabilityInstances.measurePower)) {
      this.lastMinMax.reading = reading;
      const nowTm = Date.now();
      if (!this.lastMinMaxSaveTm || (nowTm - this.lastMinMaxSaveTm) > STORE_FLUSH_MS) {
        this.lastMinMaxSaveTm = nowTm;
        await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
      }
      return;
    }

    if (deltaTm < 119000) return;
    const measureValue = this.calculateMeasureTrend(deltaMeter, deltaTm);
    await this.setCapability(this.ds.cmap.measure_source, measureValue).catch((err) => this.error(err));
    await this.checkMinMax(measureValue, reading);
  }

  calculateMeasureTrend(deltaMeter, deltaTm) {
    return Math.round((3600000000 / deltaTm) * deltaMeter);
  }

  ensureMinMaxShape(reading) {
    if (MinMaxTracker.hasShape(this.lastMinMax)) return false;
    this.lastMinMax = MinMaxTracker.createState(reading);
    return true;
  }

  async checkMinMax(val, reading) {
    if (!reading) return;
    const prefix = this.ds.cmap.minMaxPrefix || 'measure_watt';
    if (this.ensureMinMaxShape(reading)) {
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }
    let changed = MinMaxTracker.update(this.lastMinMax, val, reading);

    if (this.lastMinMax.reading !== reading) {
      this.lastMinMax.reading = reading;
      changed = true;
    }

    if (changed) {
      if (this.minMaxInitReady) {
        for (const [cap, value] of Object.entries(MinMaxTracker.capabilityValues(this.lastMinMax, prefix))) {
          await this.setCapability(cap, value).catch((err) => this.error(err));
        }
      } else {
        this.log('Skipping first min/max interval for', this.getName());
      }

      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error('Failed to save lastMinMax:', err));
    }
    this.minMaxInitReady = true;
  }

}

Object.assign(SumMeterDevice.prototype, MeterDeviceMixin);

module.exports = SumMeterDevice;
