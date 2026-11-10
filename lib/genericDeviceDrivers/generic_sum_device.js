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
const Budget = require('../Budget');
const BudgetSetup = require('../helpers/BudgetSetup');
const SettingsView = require('../helpers/SettingsView');
const PairSetup = require('../helpers/PairSetup');

// A change migrates again: budget target capabilities and the budget_info label.
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
const MoneyUnit = require('../helpers/MoneyUnit');
const FileStore = require('../helpers/FileStore');
const MeterDeviceMixin = require('./MeterDeviceMixin');

// Max time hot-path bookkeeping stays in memory before it is stored: setStoreValue() is an
// awaited IPC call inside the serialized reading loop, and listener meters tick several times
// a minute. A crash can cost at most this much bookkeeping.
const STORE_FLUSH_MS = 60 * 1000;

const SILENT_LISTENER_MS = 55 * 60 * 1000; // a listener silent this long at an hourly poll that found a new value

class SumMeterDevice extends Device {

  // The settings page shows the setup settings read-only (SettingsView): they follow every change.
  async setSettings(settings) {
    await super.setSettings(settings);
    await SettingsView.afterSet(this, settings).catch((err) => this.error(err));
  }

  static get STORE_FLUSH_MS() {
    return STORE_FLUSH_MS;
  }

  // A restart waits for a running init (restartDevice), so two inits never run at the same time.
  async onInit() {
    this.initRunning = this.initDevice();
    return this.initRunning;
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

      if (!this.migrated) {
        this.migration = this.migrate();
        await this.migration;
      }
      if (this.sessionId !== currentSessionId) return;

      // Currency and decimals of the price device, at every start (only differences are written).
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
      // Another source: its first reading continues the totals (updateMeter()).
      if (await MeterHelpers.sourceSwitched(this, ['sourceCaps'])) this.shiftNextReading = true;
      await this.setAvailable().catch((err) => this.error(err));
      await PairSetup.updatePriceInfo(this).catch((err) => this.error(err));

      if (this.settings.source_device_type === 'Homey device') {
        let api;
        try {
          api = this.homey.app.api;
        } catch {
          // ignore
        }
        if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
        await this.getSourceDevice();
        // wait for capabilitiesObj to fill
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
      } else { // realtime listener, polled every minute when it proved silent (see pollMeter())
        await this.addListeners();
        if (this.getStoreValue('pollSource')) this.startPolling(1);
        else {
          await this.pollMeter()
            .catch((error) => this.setUnavailable(error.message).catch((err) => this.error(err))); // immediate forced update
        }
      }
      await this.updateSourceLabel().catch((err) => this.error(err));

      if (typeof this.driver.checkStartPolling === 'function') {
        await this.driver.checkStartPolling();
      }

      this.initReady = true;
      // Price devices can start after this device: checked a minute later, then every hour (driver).
      this.homey.setTimeout(() => {
        if (!this.isDestroyed) this.updateWarning().catch((err) => this.error(err));
      }, 60 * 1000);

      if (this.tariffGroupChanged) {
        this.tariffGroupChanged = false;
        await this.driver.updateDeviceTariff(this).catch((err) => this.error(err));
      }
    } catch (error) {
      this.initReady = false; // retry after 5 minutes
      this.error(error);
      this.setUnavailable(error.message).catch(this.error);
    }
  }

  // Stores the throttled bookkeeping (STORE_FLUSH_MS). Subclasses with their own throttled state
  // override and call super. Must never reject: runs during shutdown.
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

      // The removed polling setting 'interval': a source the user chose to poll stays polled.
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
      // Rebuilt capabilities come back with the manifest's options: the sync after this rewrites them.
      this.capabilitiesRebuilt = await DeviceMigrator.migrateCapabilities(this, correctCaps, {
        shouldAbort: () => this.sessionId !== sessionId,
        unavailableMessage: this.homey.__('device_migrating'),
      });
      if (this.sessionId !== sessionId) return Promise.resolve(false);
      await DeviceMigrator.migrateClass(this).catch((err) => this.error(err));

      let version = '0.0.0';
      try {
        version = this.homey.app.manifest.version;
      } catch {
        // ignore
      }
      const labels = { level: version };
      if (BudgetSetup.has(this.driver.ds.driverId)) labels.budget_info = BudgetSetup.summary(this.homey, this.settings, this.driver.ds.driverId);
      // source_device_type is not shown: the name label says a virtual meter is updated via a flow.
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

  async ensureValidSettings() {
    // Default implementation does nothing
  }

  getCurrencyUnit() {
    if (this.driver.ds && (this.driver.ds.driverId === 'gas' || this.driver.ds.driverId === 'water')) return 'm³';
    return 'kWh';
  }

  onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
    if (this.shouldUpdateCurrencyOnAdd()) this.currencyChanged = true;

    // Fetch the tariff from the price driver right after pairing
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
    FileStore.remove(this).catch(() => {}); // logs its own errors
    this.log(`Meter deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Meter renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (this.lastReadingMonth && this.lastReadingYear) {
      if (changedKeys.includes('start_date')) {
        this.readStartDate(newSettings.start_date);

        const kept = MeterHelpers.keepPeriods(this.lastReadingMonth, this.lastReadingYear, TimeHelpers.toLocalDate(new Date(), this.timeZone));
        this.lastReadingMonth = kept.month;
        this.lastReadingYear = kept.year;
        await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
        await this.setStoreValue('lastReadingYear', this.lastReadingYear);
      }
    }

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

    // Handled after the restart below: Homey refuses setSettings while onSettings is pending.
    if (changedKeys.includes('tariff_update_group')) this.tariffGroupChanged = true;

    this.homey.setTimeout(() => {
      this.restartDevice(5000).catch((error) => this.error(error));
    }, 0);
    return Promise.resolve(true);
  }

  // Repair chose another source device: its listener gets a new chance.
  async onSourceChanged() {
    await this.setStoreValue('pollSource', null);
  }

  // The settings label source_capability: the capabilities of the source device in use.
  async updateSourceLabel() {
    if (this.settings.source_device_type !== 'Homey device') return;
    let text = this.settings.use_measure_source
      ? `${this.sourceWattCap || 'measure_power'} (W)`
      : Object.values(this.sourceCapGroup || {}).filter(Boolean).join(', ');
    if (!text) return;
    if (this.getStoreValue('pollSource')) text += ` (${this.homey.__('source_polled')})`;
    if (text !== this.getSettings().source_capability) await this.setSettings({ source_capability: text });
  }

  // The device warning: without a price device in its tariff group the price stays at the last one
  // (group 0: the fixed tariff settings). A driver with its own warning overrides this.
  deviceWarning() {
    const { setup } = this.driver.ds;
    if (!setup || !setup.requirePrice) return null;
    const commodity = setup.prices || 'power';
    const group = Number(this.getSettings().tariff_update_group);
    if (!group) return null;
    const fed = PriceDrivers.getDevices(this.homey, { commodity })
      .some((d) => Number(d.getSettings().tariff_update_group) === group);
    if (fed) return null;
    const ungrouped = PriceDrivers.ungroupedDevice(this.homey, commodity);
    return ungrouped ? this.homey.__('warning_price_no_group', { name: ungrouped.getName(), group })
      : this.homey.__('warning_no_price_device');
  }

  async updateWarning() {
    const warning = this.deviceWarning();
    if (warning === this.warningShown) return;
    if (warning) await this.setWarning(warning);
    else await this.unsetWarning();
    this.warningShown = warning;
  }

  // Repair: the period totals and money a user can correct (lib/helpers/FixValues.js).
  fixValues() {
    const kinds = [];
    const meterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof meterValue === 'number' && this.lastReadingDay && this.lastReadingMonth && this.lastReadingYear) {
      const unit = FixValues.unitOf(this, this.ds.cmap.this_day);
      kinds.push({
        id: 'totals',
        label: this.homey.__('repair.fix_totals'),
        info: this.homey.__('repair.fix_totals_info'),
        fields: ['day', 'month', 'year'].map((id) => FixValues.field(this, id, this.getCapabilityValue(this.ds.cmap[`this_${id}`]), unit, 4)),
      });
    }
    const money = FixValues.moneyKind(this);
    if (money) kinds.push(money);
    return { kinds };
  }

  async applyFixValues({ kind, values } = {}) {
    if (kind === 'totals') return this.fixTotals(FixValues.parse(this, values, ['day', 'month', 'year']));
    if (kind === 'money') return this.fixMoney(FixValues.parse(this, values, Object.keys(FixValues.MONEY)));
    throw Error(this.homey.__('error_device_corrupt'));
  }

  // A period total is the live reading minus the period's start reading: the start moves.
  async fixTotals(totals) {
    const meterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof meterValue !== 'number' || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear) {
      throw Error(this.homey.__('error_device_corrupt'));
    }
    // A meter that counts down (e.g. solar/export wired negative) has negative totals (issue #353).
    const direction = this.countingDirection(
      meterValue,
      meterValue - this.lastReadingYear.meterValue,
      meterValue - this.lastReadingMonth.meterValue,
    ) < 0 ? -1 : 1;
    if (Object.values(totals).some((total) => total * direction < 0)) throw Error(this.homey.__('error_total_invalid'));
    const keys = { day: 'lastReadingDay', month: 'lastReadingMonth', year: 'lastReadingYear' };
    for (const [id, total] of Object.entries(totals)) {
      const key = keys[id];
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
    // An edited month/year total replaces the fixed costs booked in it: a reset (0) holds none,
    // any other value is taken to hold what the markups added so far (never more than a positive total).
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

  // The source's measure_power as realtime value of the measure capability (not for m³ meters).
  usesRealtimePower() {
    return true;
  }

  // Detected by the driver, with the choice from the setup view (store 'sourceCaps').
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
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    const meterCap = this.ds.cmap.meter_source;
    const targetMeasureCap = this.ds.cmap.measure_source;

    // METER_VIA_WATT: the power capability chosen in the setup view
    if (this.getSettings().use_measure_source) {
      this.sourceWattCap = this.driver.wattCapFor
        ? this.driver.wattCapFor(this.sourceDevice, this.getStoreValue('sourceCaps')) : 'measure_power';
      if (this.sourceWattCap && this.sourceDevice.capabilities.includes(this.sourceWattCap)) {
        this.log(`registering ${this.sourceWattCap} capability listener for ${this.sourceDevice.name}`);
        this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance(this.sourceWattCap, async (value) => {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          // Feed min/max from the raw realtime value, not the 2-minute averaged trend.
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

    // measure_power as well, for realtime updates without energy-step spikes
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
    // The values from a request: the cached object stays as silent as a dead listener.
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
    // A source whose listener stayed silent for an hour while its meter moved: poll it every minute
    // from now on (kept in the store over restarts).
    const silentMs = Date.now() - (this.lastListenerTm || this.listenStartTm || Date.now());
    if (missed && silentMs > SILENT_LISTENER_MS && !this.intervalIdDevicePoll && this.listenStartTm) {
      this.log(`${this.getName()}: no listener updates for ${Math.round(silentMs / 60000)} minutes, polling the source every minute`);
      await this.setStoreValue('pollSource', true).catch((err) => this.error(err));
      this.startPolling(1);
      await this.updateSourceLabel().catch((err) => this.error(err));
    }
    this.lastGroupMeterReady = true;
    await this.updateGroupMeter().catch(this.error);

    // also poll measure_power for realtime updates
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
        this.initReady = false; // restart within 5 minutes
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
      // 0 until the first price broadcast; an older device keeps its removed tariff setting's value.
      const start = typeof this.settings.tariff === 'number' ? this.settings.tariff : 0;
      this.tariffHistory = {
        previous: null, // still used just after newHour
        previousTm: null,
        previousExport: null,
        current: start,
        currentExport: start, // overwritten by the price broadcast; avoids NaN
        currentTm: new Date(),
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory);
    }
    if (!this.priceInterval) this.priceInterval = await this.getStoreValue('priceInterval') || 60;
    await this.applyFixedTariff();

    if (!this.newReadings) this.newReadings = [];

    this.readStartDate(this.settings.start_date);

    // Also after a settings change (restartDevice keeps the instance)
    this.budgets = this.getBudgets();

    if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
    if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
    if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

    // daily resetting source devices
    if (!this.dayStartCumVal) this.dayStartCumVal = (this.lastReadingDay && this.lastReadingDay.meterValue) || 0;
    if (!this.cumVal) this.cumVal = this.dayStartCumVal;
    if (!this.lastAbsVal) this.lastAbsVal = 0;

    if (!this.lastMinMax) this.lastMinMax = await this.getStoreValue('lastMinMax');
    // Migrate an old-shape lastMinMax before any listener fires (see ensureMinMaxShape()).
    if (this.lastMinMax && this.lastMinMax.reading && this.ensureMinMaxShape(this.lastMinMax.reading)) {
      this.log(`${this.getName()}: migrated stored lastMinMax to the day/month/year shape`);
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }

    // pairing: init meter_power for use_measure_source
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
      // pairing
      if (typeof this.lastMeasure.value !== 'number') this.lastMeasure.value = 0;
    }
    // assume 0 power when not seen for 5 minutes
    if ((new Date() - new Date(this.lastMeasure.measureTm)) > 300000) this.lastMeasure.value = 0;

    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities(this.ds.cmap.meter_source);

    // Fixed costs (markups) in meterMoney.month/year, kept apart so the _avg capabilities show the
    // energy price per kWh (issue #229).
    if (!this.fixedMoney) {
      this.fixedMoney = await this.getStoreValue('fixedMoney');
      if (!this.fixedMoney) {
        this.fixedMoney = this.estimateFixedMoney();
        await this.setStoreValue('fixedMoney', this.fixedMoney).catch((err) => this.error(err));
      }
    }
  }

  // One-time seed for devices from before fixedMoney: what the current markups would have added
  // since the period's first reading. Not capped at the booked money (an exporter can be negative).
  estimateFixedMoney() {
    const { markup_hour: hour = 0, markup_day: day = 0, markup_month: month = 0 } = this.getSettings();
    const nowMs = Date.now();
    const nowLocal = TimeHelpers.toLocalDate(new Date(nowMs), this.timeZone);
    const localDayNr = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * 60 * 60 * 1000);
    const startOf = (d) => MeterHelpers.monthStartDay(this.startDay, d.getFullYear(), d.getMonth());
    const billingMonthNr = (d) => (d.getFullYear() * 12) + d.getMonth() - (d.getDate() < startOf(d) ? 1 : 0);
    const bookedSince = (reading) => {
      const fromMs = reading ? new Date(reading.meterTm).getTime() : NaN;
      if (!Number.isFinite(fromMs) || fromMs > nowMs) return 0;
      const fromLocal = TimeHelpers.toLocalDate(new Date(fromMs), this.timeZone);
      const opened = (fromLocal.getDate() === startOf(fromLocal) && fromLocal.getHours() === 0) ? 1 : 0;
      const hours = Math.floor(nowMs / 3600000) - Math.floor(fromMs / 3600000) + opened;
      const days = localDayNr(nowLocal) - localDayNr(fromLocal) + opened;
      const months = billingMonthNr(nowLocal) - billingMonthNr(fromLocal) + opened;
      return Math.max(0, (month * months) + (day * days) + (hour * hours));
    };
    return {
      month: bookedSince(this.lastReadingMonth),
      year: bookedSince(this.lastReadingYear),
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
    }
    if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
    // pairing: min/max trackers
    if (this.ensureMinMaxShape(reading)) {
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }
    this.initReady = true;
    this.firstReadingDone = true;
  }

  // Tariff group 0: the fixed tariff settings, no Energy Price device. tariff_export (power, solar,
  // grid) is new: an older device got the same export price, once (store fixedExport).
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

  // Anomalous jumps in the cumulative meter value:
  // - IMPOSSIBLE value: rejected, never confirmed.
  // - ANOMALY (scaled to this device's usage, anomalyCeiling()): withheld. Confirmed by the next
  //   reading near the new level, then all baselines are re-anchored; discarded when it falls back.
  // - GROSS jump: as an anomaly, but needs one extra consistent reading.
  // Issues #126/#234/#341, #155/#215/#289/#353.
  async checkMeterJump(value) {
    const GROSS_JUMP = 10000; // trusted only after 3 readings
    // No domestic meter reaches this (registers roll over below 1e7). A judgement call, not a spec.
    // The only outright rejection, so it must stay above any real meter (a real value above it would
    // deadlock the device).
    const IMPOSSIBLE_METER = 1e7;

    if (!Number.isFinite(value) || Math.abs(value) > IMPOSSIBLE_METER) {
      this.pendingAnomaly = null;
      throw Error(`ignoring impossible incoming meter value! ${value}`);
    }

    const lastVal = this.getCapabilityValue(this.ds.cmap.meter_source);
    // Math.abs(): a meter wired negative is protected too (issue #353).
    if (lastVal === null || !Number.isFinite(lastVal) || !(Math.abs(lastVal) > 1)) {
      this.pendingAnomaly = null;
      return;
    }
    // The stored reading itself is corrupt: re-anchor, or every valid reading is rejected forever.
    if (Math.abs(lastVal) > IMPOSSIBLE_METER) {
      this.pendingAnomaly = null;
      this.log(`${this.getName()}: stored meter value ${lastVal} is impossible. Re-anchoring baselines to ${value}.`);
      await this.reanchorBaselines(value);
      return;
    }
    const meterDelta = Math.abs(value - lastVal);
    const anomalyJump = this.anomalyCeiling();
    if (meterDelta > anomalyJump || meterDelta > GROSS_JUMP) {
      // Never reject a gross jump outright: later valid readings would all be rejected against the
      // stale value (deadlock). A flapping source never confirms: a reading back near the original
      // clears pendingAnomaly.
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

  // One poll-to-poll delta may not be over 20x this device's last full hour or 20x its last full
  // day (bursty devices such as EV chargers); a fixed floor without history.
  // 1 or -1: the way the meter went this year (else this month), not the sign of the reading: a net
  // meter can stand below zero and still count up.
  countingDirection(meterValue, valYear, valMonth) {
    const MIN_TREND = 1; // kWh, or m³ for gas/water
    if (Math.abs(valYear) >= MIN_TREND) return Math.sign(valYear);
    if (Math.abs(valMonth) >= MIN_TREND) return Math.sign(valMonth);
    return meterValue < 0 ? -1 : 1;
  }

  anomalyCeiling() {
    const RATIO = 20;
    const FLOOR = 1; // kWh, or m³ for gas/water
    const lastHour = this.getCapabilityValue(this.ds.cmap.last_hour);
    const lastDay = this.getCapabilityValue(this.ds.cmap.last_day);
    const reference = Math.max(
      typeof lastHour === 'number' ? Math.abs(lastHour) : 0,
      typeof lastDay === 'number' ? Math.abs(lastDay) : 0,
    );
    return Math.max(FLOOR, reference * RATIO);
  }

  // The first reading of another source device: the totals and money go on from it, without a jump
  // and without booking the difference between the two meters.
  async continueFromNewSource(value) {
    this.shiftNextReading = false;
    this.pendingAnomaly = null;
    const last = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (!Number.isFinite(last) || !this.lastReadingYear) return;
    this.log(`${this.getName()}: source switched (${last} -> ${value}), totals continue`);
    await MeterHelpers.shiftBaselines(this, value - last);
    await this.setCapability(this.ds.cmap.meter_source, value).catch((err) => this.error(err));
  }

  // Re-anchors all period baselines and the money reference to a confirmed new meter value.
  async reanchorBaselines(meterValue) {
    const keys = ['lastReadingHour', 'lastReadingDay', 'lastReadingMonth', 'lastReadingYear'];
    await Promise.all(keys.map(async (key) => {
      if (this[key]) {
        this[key] = { ...this[key], meterValue };
        await this.setStoreValue(key, this[key]).catch((err) => this.error(err));
      }
    }));
    if (this.meterMoney) this.meterMoney.meterValue = meterValue;
    await this.reanchorExtraBaselines(meterValue).catch((err) => this.error(err));
  }

  // Hook for a subclass with its own anchors the base never sees (e.g. the grid's raw
  // import/export registers): it must re-anchor them too. No-op here.
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
      // Daily resetting meters. Not on a selfPoll: `val` is then our own already transformed value.
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
      // firstReadingDone, not initReady: initReady is also set true early for polling devices.
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

  async updateMeterFromFlow(args) {
    if (!this.migrated || this.currencyChanged) return;
    let value = null;
    if (args && args.value !== undefined) value = args.value;
    else if (typeof args === 'number') value = args;

    // A poll re-feeds our own meter value only so the rollovers fire. checkMeterJump() is skipped:
    // its zero delta would clear a pending anomaly every hour.
    const selfPoll = (value === null);
    if (selfPoll) {
      value = this.getCapabilityValue(this.ds.cmap.meter_source);
      if (value === null) return;
    }
    await this.updateMeter(value, { selfPoll });
  }

  // takes Watt, creates kWh meter value
  async updateMeterFromMeasure(val) {
    if (!this.migrated || this.currencyChanged) return;
    const measureTm = new Date();
    let value = val;
    if (value === null && !this.settings.source_device_type.includes('Homey Energy')) { // poll requested or app init
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
    return MeterHelpers.getPeriods(
      reading,
      this.lastReadingHour,
      this.lastReadingDay,
      this.lastReadingMonth,
      this.lastReadingYear,
      this.startDay,
      this.startMonth,
    );
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

  // "Local climate": the profile for the location (solar: its own lat/lon) and the heating and
  // cooling settings. Fetched in the background; the fixed profile is used until then.
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

    // Self-heal an hour/day baseline that is off from the live meter by an implausible margin
    // (relative to this device's usage) against the meter's counting direction. A meter wired
    // negative counts down, so there a large negative total is legit (issue #353). Small deltas
    // against the direction are legit (net meters). Skipped without history. Month and year are
    // not checked: a ceiling scaled to the last hour/day says nothing about a month/year total.
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
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
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

  // Hook for a subclass settlement scheme: a number overrides the default deltaMoney, null keeps it.
  async getMoneyDeltaOverride() {
    return null;
  }

  async updateMoney({ ...reading }, { ...periods }) {
    // Tariff for this reading across a price-period boundary, see MeterHelpers.getPeriodTariff().
    const priceInterval = this.priceInterval || 60;
    const lastReadingTm = this.lastMoneyReadingTm || new Date(new Date(reading.meterTm).getTime() - 1000);
    const { tariff, exportTariff } = MeterHelpers.getPeriodTariff(this.tariffHistory, priceInterval, reading.meterTm, lastReadingTm, undefined, this.timeZone);

    this.lastMoneyReadingTm = reading.meterTm;

    const safeExportTariff = exportTariff !== undefined && exportTariff !== null ? exportTariff : tariff;

    const activeTariff = this.getActiveTariff(reading, tariff, safeExportTariff);

    // meter_tariff is the tariff now: a delta across the boundary is paid at the previous one, the
    // capability does not go back to it.
    const { current, currentExport } = this.tariffHistory;
    const nowTariff = this.getActiveTariff(reading, current, typeof currentExport === 'number' ? currentExport : current);
    if (nowTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', nowTariff).catch((err) => this.error(err));

    const deltaMoneyOverride = await this.getMoneyDeltaOverride(reading, periods);
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff, deltaMoneyOverride);

    // The fixed costs (markups) of each period that starts.
    const settings = this.getSettings();
    const rolled = await this.rollMoneyPeriods(meterMoney, periods);
    const fixedMarkup = rolled.reduce((sum, name) => sum + (settings[`markup_${name}`] || 0), 0);
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;
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
    this.meterMoney = meterMoney;
  }

  // Energy price per kWh: fixed costs excluded (see fixedMoney).
  async updateAvgMoney() {
    const fixed = this.fixedMoney || { month: 0, year: 0 };
    const moneyThisMonth = this.meterMoney.month - fixed.month;
    const meterThisMonth = this.getCapabilityValue(this.ds.cmap.this_month);
    if (meterThisMonth) await this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth).catch((err) => this.error(err));

    const moneyThisYear = this.meterMoney.year - fixed.year;
    const meterThisYear = this.getCapabilityValue(this.ds.cmap.this_year);
    if (meterThisYear) await this.setCapability('meter_money_this_year_avg', moneyThisYear / meterThisYear).catch((err) => this.error(err));
  }

  async updateMeasureMinMax({ ...reading }) {
    // minimal 2 minutes needed
    const deltaTm = new Date(reading.meterTm) - new Date(this.lastMinMax.reading.meterTm);
    const deltaMeter = reading.meterValue - this.lastMinMax.reading.meterValue;

    // No trend calculation with a realtime power listener: those feed checkMinMax() directly.
    if (this.capabilityInstances && (this.capabilityInstances.measurePowerRealtime || this.capabilityInstances.measurePower)) {
      this.lastMinMax.reading = reading;
      // Persisting is throttled (this was the most frequent store write); the in-memory update is not.
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
    // kWh -> W
    return Math.round((3600000000 / deltaTm) * deltaMeter);
  }

  // Creates lastMinMax or migrates the old single-pair shape to day/month/year trackers. true
  // when changed. Called from several places: the realtime paths call checkMinMax() directly.
  ensureMinMaxShape(reading) {
    if (MinMaxTracker.hasShape(this.lastMinMax)) return false;
    this.lastMinMax = MinMaxTracker.createState(reading);
    return true;
  }

  // Day/month/year min/max (MinMaxTracker), from the trend fallback and two realtime listeners.
  // minMaxPrefix selects 'measure_watt' or 'measure_lpm'.
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
      if (this.minMaxInitReady) { // skip the first interval after app start: polling does not know the right timestamp
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
