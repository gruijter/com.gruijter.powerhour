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
const BatFlows = require('../flows/BatFlows');
const MeterHelpers = require('../helpers/MeterHelpers');
const ContractYear = require('../helpers/ContractYear');
const HistoryRestore = require('../helpers/HistoryRestore');
const TimeHelpers = require('../helpers/TimeHelpers');

const PriceShift = require('../helpers/PriceShift');
const Budget = require('../Budget');
const BudgetSetup = require('../helpers/BudgetSetup');
const SettingsView = require('../helpers/SettingsView');
const MigrationNotice = require('../helpers/MigrationNotice');
const DeviceMigrator = require('../DeviceMigrator');
const CapabilityOptions = require('../helpers/CapabilityOptions');
const { awaitMigration } = require('../helpers/Util');
const FixValues = require('../helpers/FixValues');
const MoneyUnit = require('../helpers/MoneyUnit');
const PriceDrivers = require('../helpers/PriceDrivers');
const PairSetup = require('../helpers/PairSetup');

const COUNTER_PERIODS = ['hour', 'day', 'month', 'year'];
const COUNTER_KINDS = ['charged', 'discharged'];
const FileStore = require('../helpers/FileStore');
const MeterDeviceMixin = require('./MeterDeviceMixin');

// The prices from the price device: in the file store, as they change every price slot.
const PRICE_KEYS = ['pricesNextHours', 'exportPricesNextHours', 'pricesNextHoursMarketLength', 'pricesNextHoursIsForecast',
  'priceInterval', 'pricesStartTm'];

// A larger jump between two readings is an anomaly (migration, device replacement).
const MAX_METER_JUMP_KWH = 50;

class BatDevice extends Device {

  // The settings page shows the setup settings read-only (SettingsView): they follow every change.
  async setSettings(settings) {
    await super.setSettings(settings);
    await SettingsView.afterSet(this, settings).catch((err) => this.error(err));
  }

  // A restart waits for a running init (restartDevice), so two inits never run at the same time.
  async onInit() {
    this.initRunning = this.initDevice();
    return this.initRunning;
  }

  async initDevice() {
    try {
      this.restarting = false;
      this.initReady = false;
      if (!this.flows) this.flows = new BatFlows(this);

      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      this.timeZone = this.homey.clock.getTimezone();

      if (!this.migrated) {
        this.migration = this.migrate();
        await this.migration;
      }
      this.migrated = true;
      // Another source: its first readings continue the totals (handleUpdateMeter()). With charge and
      // discharge meters, each one's first reading.
      if (await MeterHelpers.sourceSwitched(this, ['sourceCaps', 'evChargerCaps'])) {
        this.shiftNextReading = true;
        this.switchRegisters = new Set(['meterCharging', 'meterDischarging']);
      }
      // The learned phases are those of the source device: another one is learned again.
      const phaseSource = this.getSettings().homey_device_id || null;
      if (this.getStoreValue('phaseSource') !== phaseSource) {
        if (this.getStoreKeys().includes('phaseSource')) await this.unsetStoreValue('phaseVotes').catch((err) => this.error(err));
        await this.setStoreValue('phaseSource', phaseSource).catch((err) => this.error(err));
      }
      await PairSetup.updatePriceInfo(this).catch((err) => this.error(err));

      // Currency and decimals of the price device, at every start (only differences are written).
      const { currency, decimals } = MoneyUnit.get(this);
      await DeviceMigrator.syncCapabilityOptions(this, CapabilityOptions.currency(this.getCapabilities(), {
        currency, decimals, defaultCurrency: '€', perUnit: 'kWh',
      }), { force: this.capabilitiesRebuilt });
      this.capabilitiesRebuilt = false;
      this.currencyChanged = false;
      await this.setAvailable().catch((err) => this.error(err));

      await this.initDeviceValues();

      await this.addListeners();

      await this.poll();

      if (typeof this.driver.checkStartPolling === 'function') {
        await this.driver.checkStartPolling();
      }

      this.initReady = true;

      if (this.tariffGroupChanged) {
        this.tariffGroupChanged = false;
        await this.driver.setPricesDevice(this).catch((err) => this.error(err));
      }
    } catch (error) {
      this.error(error);
      this.setUnavailable(error.message).catch((err) => this.error(err));
      this.initReady = false; // retry after 5 minutes
    }
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    this.destroyListeners();
    await awaitMigration(this);
    await FileStore.close(this);
  }

  async migrate() {
    try {
      this.migrated = false;
      const budgetFix = BudgetSetup.migrate(this.getSettings(), this.driver.ds.driverId);
      if (budgetFix) await this.setSettings(budgetFix).catch((err) => this.error(err));
      // Setting roiEnable became precisePlanning (the LP). v8's roiEnable switched ROI on at all; in
      // v9 every battery plans, and the LP needs far more memory: v8 batteries get the light planner.
      const old = this.getSettings();
      if (this.driver.id === 'battery' && typeof old.precisePlanning !== 'boolean') {
        const precisePlanning = parseInt(String(old.level || '0'), 10) >= 9 && !!old.roiEnable;
        this.log(`${this.getName()}: precisePlanning ${precisePlanning}`);
        await this.setSettings({ precisePlanning }).catch((err) => this.error(err));
      }
      // Renamed settings: the old value once under the new id.
      const renamed = {};
      [['roiMinProfit', 'minProfit'], ['roiWearCost', 'wearCost']].forEach(([from, to]) => {
        if (old[to] === undefined && old[from] !== undefined && old[from] !== null) renamed[to] = old[from];
      });
      if (this.driver.id === 'battery' && Object.keys(renamed).length) {
        this.log(`${this.getName()}: renamed settings ${JSON.stringify(renamed)}`);
        await this.setSettings(renamed).catch((err) => this.error(err));
      }
      const correctCaps = this.correctCapabilities();
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
      MigrationNotice.noteUpdate(this.homey, this.getSettings().level);
      const labels = { level: version };
      if (BudgetSetup.has(this.driver.ds.driverId)) labels.budget_info = BudgetSetup.summary(this.homey, this.getSettings(), this.driver.ds.driverId);
      await this.setSettings(labels).catch((err) => this.error(err));
      await SettingsView.update(this).catch((err) => this.error(err));
      return Promise.resolve(true);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
    }
  }

  // The capabilities this device should have, in order: the same list as at pairing.
  correctCapabilities() {
    return this.driver.capabilitiesFor(this.getSettings());
  }

  onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);

    // Fetch the active prices from the price driver cache immediately after pairing
    if (this.driver.setPricesDevice) {
      this.homey.setTimeout(() => {
        if (!this.isDestroyed) this.driver.setPricesDevice(this).catch((err) => this.error(err));
      }, 3000);
    }
  }

  onDeleted() {
    this.isDestroyed = true;
    this.destroyListeners();
    FileStore.remove(this).catch(() => {}); // logs its own errors
    this.log(`Deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`${this.getName()} was renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (EnergyExclude.onlyHomeyEnergy(changedKeys)) return undefined; // Homey's own Energy settings: nothing to do
    this.log(`${this.getName()} device settings changed by user`, newSettings);
    if (changedKeys.includes('budget')) {
      const reason = Budget.invalidReason(newSettings.distribution || this.getSettings().distribution, newSettings.budget);
      if (reason) throw Error(this.homey.__(reason));
    }
    if (['start_date', 'distribution', 'budget', 'v2x'].some((key) => changedKeys.includes(key))) this.migrated = false;
    // Handled after the restart below: Homey refuses setSettings while onSettings is pending.
    if (changedKeys.includes('tariff_update_group')) this.tariffGroupChanged = true;
    this.homey.setTimeout(() => {
      this.restartDevice(5000).catch((error) => this.error(error));
    }, 0);
    return Promise.resolve(true);
  }

  // Repair: the money and, when counted here, the charged/discharged meters a user can correct
  // (lib/helpers/FixValues.js).
  fixValues() {
    const kinds = [];
    const money = FixValues.moneyKind(this);
    if (money) kinds.push(money);
    const fields = this.fixMeterCaps().map(([id, cap]) => FixValues.field(this, id, this.getCapabilityValue(cap), FixValues.unitOf(this, cap), 4, `repair.fix_${id}`));
    if (fields.length) kinds.push({ id: 'meters', label: this.homey.__('repair.fix_meters'), fields });
    return { kinds };
  }

  // A meter of the source device is not ours to correct: its next reading overwrites it.
  fixMeterCaps() {
    if (this.sourceCapGroup && (this.sourceCapGroup.meterCharging || this.sourceCapGroup.meterDischarging)) return [];
    return [['charged', 'meter_kwh_charging'], ['discharged', 'meter_kwh_discharging']].filter(([, cap]) => this.hasCapability(cap));
  }

  async applyFixValues({ kind, values } = {}) {
    if (kind === 'money' && this.meterMoney) {
      const fixed = FixValues.parse(this, values, Object.keys(FixValues.MONEY));
      this.meterMoney = { ...this.meterMoney, ...fixed };
      for (const [id, cap] of Object.entries(FixValues.MONEY)) {
        if (fixed[id] !== undefined) await this.setCapability(cap, fixed[id]);
      }
      await this.updateAvgMoney().catch((err) => this.error(err));
      this.log(`${this.getName()} money fixed in repair`, fixed);
      return;
    }
    if (kind === 'meters') {
      const caps = this.fixMeterCaps();
      const fixed = FixValues.parse(this, values, caps.map(([id]) => id));
      if (Object.values(fixed).some((v) => v < 0)) throw Error(this.homey.__('error_total_invalid'));
      for (const [id, cap] of caps) {
        if (fixed[id] !== undefined) await this.setCapability(cap, fixed[id]);
      }
      this.log(`${this.getName()} meters fixed in repair`, fixed);
      return;
    }
    throw Error(this.homey.__('error_device_corrupt'));
  }

  async initDeviceValues() {
    if (!this.available) this.setAvailable().catch((err) => this.error(err));
    this.log(`${this.getName()} Restoring device values after init`);

    const files = await FileStore.open(this, PRICE_KEYS);
    if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = files.get('pricesNextHoursMarketLength');
    if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = 99;
    if (!this.pricesNextHoursIsForecast) this.pricesNextHoursIsForecast = files.get('pricesNextHoursIsForecast');
    if (!this.pricesNextHours) this.pricesNextHours = files.get('pricesNextHours');
    if (!this.exportPricesNextHours) this.exportPricesNextHours = files.get('exportPricesNextHours');
    if (!this.exportPricesNextHours) this.exportPricesNextHours = this.pricesNextHours;
    if (!this.priceInterval) this.priceInterval = files.get('priceInterval') || 60;
    if (!this.pricesStartTm) this.pricesStartTm = files.get('pricesStartTm');
    if (!this.pricesNextHours) {
      this.pricesNextHours = [0.25]; // default after pairing
    }

    if (!this.tariffHistory) this.tariffHistory = await this.getStoreValue('tariffHistory');
    if (!this.tariffHistory) {
      this.tariffHistory = {
        previous: this.pricesNextHours ? this.pricesNextHours[0] : 0,
        previousExport: this.exportPricesNextHours ? this.exportPricesNextHours[0] : 0,
        previousTm: new Date(Date.now() - 3600000),
        current: this.pricesNextHours ? this.pricesNextHours[0] : 0,
        currentExport: this.exportPricesNextHours ? this.exportPricesNextHours[0] : 0,
        currentTm: new Date(),
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory).catch((err) => this.error(err));
    }

    if (!this.newReadings) this.newReadings = [];

    const storedkWh = this.hasCapability('meter_kwh_stored') ? (this.getCapabilityValue('meter_kwh_stored') || 0) : 0;
    const capacity = this.capacityKwh() || 50; // avoid division by zero
    this.soc = (storedkWh / capacity) * 100;
    if (!this.soc) this.soc = 0;

    this.xomTargetPower = 0;

    await this.followPeriodStarts();
    this.budgets = null; // recalculated by updateTargets(), also after a settings change

    if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
    if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
    if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');
    await this.updateCounterPeriods({
      newHour: false, newDay: false, newMonth: false, newYear: false,
    }).catch((err) => this.error(err));

    // pairing: init meter_power_hidden for use_measure_source
    const meterX = this.getCapabilityValue('meter_power_hidden');
    if (typeof meterX !== 'number') {
      this.log('meter kWh is set to 0 after device pair');
      await this.setCapability('meter_power_hidden', 0);
    }

    if (!this.lastMeasure) {
      this.lastMeasure = {
        value: 0,
        measureTm: new Date(),
      };
    }

    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities('meter_power_hidden');
  }

  async initFirstReading({ ...reading }) {
    const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
    if (pairInit) {
      this.log(`${this.getName()} Setting values after pair init`);
      await this.setStoreValue('lastReadingHour', reading);
      this.lastReadingHour = reading;
      const dayStart = this.getSettings().homey_device_daily_reset ? await this.getReadingObject(0) : reading;
      await this.setStoreValue('lastReadingDay', dayStart);
      this.lastReadingDay = dayStart;
      await this.setStoreValue('lastReadingMonth', reading);
      this.lastReadingMonth = reading;
      await this.setStoreValue('lastReadingYear', reading);
      this.lastReadingYear = reading;
    }
    // pairing
    if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
    if (pairInit) {
      this.homey.setTimeout(() => {
        this.restoreCounterReadings().catch((err) => this.error(err));
      }, 0);
    }
    this.firstReadingDone = true;
  }

  /**
   * The prices from the current price slot on. A price list starts at pricesStartTm: after a slot
   * change its first entries are past until the next broadcast, which comes seconds later (and
   * after a restart the stored list can be hours old). A list without pricesStartTm (a tariff set
   * by flow) is valid as it is until the next one.
   *
   * @returns {{prices, exportPrices, isForecast, marketLength}}
   */
  pricesFromNow(now = Date.now()) {
    const out = {
      prices: this.pricesNextHours,
      exportPrices: this.exportPricesNextHours,
      isForecast: this.pricesNextHoursIsForecast,
      marketLength: this.pricesNextHoursMarketLength,
    };
    if (!Array.isArray(out.prices) || !out.prices.length || !Number.isFinite(this.pricesStartTm)) return out;
    const passed = PriceShift.passedSlots(this.pricesStartTm, this.priceInterval || 60, this.timeZone, now);
    if (passed <= 0) return out;
    // All past (no broadcast for that long): the last price, as for a flow tariff.
    const skip = Math.min(passed, out.prices.length - 1);
    const cut = (list) => (Array.isArray(list) ? list.slice(skip) : list);
    return {
      prices: cut(out.prices),
      exportPrices: cut(out.exportPrices),
      isForecast: cut(out.isForecast),
      marketLength: typeof out.marketLength === 'number' ? Math.max(0, out.marketLength - passed) : out.marketLength,
    };
  }

  // Two or more price devices send to this device's tariff group, else null.
  groupWarning() {
    return PriceDrivers.groupConflict(this.homey, 'power', this.getSettings().tariff_update_group);
  }

  deviceWarning() {
    return this.groupWarning();
  }

  async updateWarning() {
    const warning = this.deviceWarning();
    if (warning === undefined || warning === this.warningShown) return;
    this.warningShown = warning;
    if (warning) await this.setWarning(warning).catch(this.error);
    else await this.unsetWarning().catch(this.error);
  }

  async updatePrices(pricesNextHours, exportPricesNextHours, pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast, moneyUnit, pricesStartTm) {
    try {
      await this.updateWarning();
      await PairSetup.updatePriceInfo(this).catch((err) => this.error(err));
      const files = await FileStore.open(this);
      if (!pricesNextHours || !pricesNextHours[0]) {
        this.pricesNextHours = null;
        this.exportPricesNextHours = null;
        this.pricesNextHoursMarketLength = 0;
        this.pricesNextHoursIsForecast = null;
        this.pricesStartTm = null;
        files.set('pricesNextHours', null);
        files.set('exportPricesNextHours', null);
        files.set('pricesNextHoursMarketLength', 0);
        files.set('pricesNextHoursIsForecast', null);
        files.set('pricesStartTm', null);
        return;
      }
      this.pricesNextHoursMarketLength = pricesNextHoursMarketLength;
      this.pricesNextHoursIsForecast = pricesNextHoursIsForecast;

      if (await MoneyUnit.take(this, moneyUnit)) {
        this.log('Currency from the price device:', moneyUnit);
        this.currencyChanged = true;
        await SettingsView.update(this).catch((err) => this.error(err));
        this.homey.setTimeout(() => {
          this.restartDevice(2000).catch(this.error);
        }, 0);
      }

      const pricesChanged = JSON.stringify(pricesNextHours) !== JSON.stringify(this.pricesNextHours) || JSON.stringify(exportPricesNextHours) !== JSON.stringify(this.exportPricesNextHours);
      const intervalChanged = this.priceInterval !== priceInterval;
      const startTm = Number.isFinite(pricesStartTm) ? pricesStartTm : null;
      const startChanged = startTm !== (Number.isFinite(this.pricesStartTm) ? this.pricesStartTm : null);
      if (this.initReady && !pricesChanged && !intervalChanged && !startChanged) return;

      this.pricesNextHours = pricesNextHours;
      this.exportPricesNextHours = exportPricesNextHours;
      this.priceInterval = priceInterval;
      this.pricesStartTm = startTm;
      // A list re-sent from the driver's cache (pairing, restart) can start in a past slot.
      await this.applySlotTariff();
      files.set('pricesNextHours', pricesNextHours);
      files.set('exportPricesNextHours', exportPricesNextHours);
      files.set('pricesNextHoursMarketLength', pricesNextHoursMarketLength);
      files.set('pricesNextHoursIsForecast', pricesNextHoursIsForecast);
      files.set('priceInterval', priceInterval);
      files.set('pricesStartTm', startTm);
      // Not awaited: the driver hands the devices their prices one after the other; a battery group
      // then plans with the new prices of all members.
      if (this.initReady && this.onPricesUpdated) this.onPricesUpdated().catch((err) => this.error(err));
    } catch (error) {
      this.error(error);
    }
  }

  // The tariff of the current price slot from the list (also at a slot change without a
  // broadcast): meter_tariff and the tariff history for money across the boundary.
  async applySlotTariff() {
    if (!Array.isArray(this.pricesNextHours) || !this.pricesNextHours.length) return;
    const fromNow = this.pricesFromNow();

    const activeTariff = MeterHelpers.getActiveTariff(
      this.getSettings(),
      this.currentGridPower,
      fromNow.prices[0],
      fromNow.exportPrices[0],
    );

    // 15/60 min boundary crossed: shift the history
    let crossedBoundary = true;
    if (this.tariffHistory && this.tariffHistory.currentTm) {
      const lastTm = new Date(this.tariffHistory.currentTm);
      const pInt = this.priceInterval || 60;
      const lastBoundary = MeterHelpers.startOfBlock(lastTm, pInt, this.timeZone);
      const currentBoundary = MeterHelpers.startOfBlock(new Date(), pInt, this.timeZone);
      crossedBoundary = currentBoundary > lastBoundary;
    }

    let prevPrice = fromNow.prices[0];
    let prevExportPrice = fromNow.exportPrices[0];
    let prevTime = new Date(Date.now() - 3600000);
    if (this.tariffHistory) {
      prevPrice = crossedBoundary ? this.tariffHistory.current : this.tariffHistory.previous;
      prevExportPrice = crossedBoundary ? this.tariffHistory.currentExport : this.tariffHistory.previousExport;
      prevTime = crossedBoundary ? this.tariffHistory.currentTm : this.tariffHistory.previousTm;
    }

    this.tariffHistory = {
      previous: prevPrice,
      previousExport: prevExportPrice,
      previousTm: prevTime,
      current: fromNow.prices[0],
      currentExport: fromNow.exportPrices[0],
      currentTm: new Date(),
    };
    await this.setStoreValue('tariffHistory', this.tariffHistory).catch((err) => this.error(err));

    await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));
  }

  // A new price slot (driver's quarter tick): its tariff from the list, without a broadcast.
  async onPriceSlot() {
    if (!this.initReady || !Number.isFinite(this.pricesStartTm) || !this.tariffHistory || !this.tariffHistory.currentTm) return;
    if (!PriceShift.isNewSlot(this.tariffHistory.currentTm, this.priceInterval, this.timeZone)) return;
    await this.applySlotTariff();
  }

  async handleUpdateMeter(reading) {
    try {
      // Massive meter jumps (migration, device replacement)
      const lastMeterValue = this.getCapabilityValue('meter_power_hidden');
      if (typeof lastMeterValue === 'number') {
        const meterDelta = Math.abs(reading.meterValue - lastMeterValue);
        const rebase = this.rebaseNextReading;
        this.rebaseNextReading = false;
        if (this.shiftNextReading) {
          // Another source device: the totals and money go on, the difference between the meters is not booked.
          this.shiftNextReading = false;
          this.log(`Source switched (${lastMeterValue} -> ${reading.meterValue}), totals continue`);
          await MeterHelpers.shiftBaselines(this, reading.meterValue - lastMeterValue);
        } else if (meterDelta > MAX_METER_JUMP_KWH || rebase) {
          this.log(`Meter jump (${meterDelta.toFixed(2)} kWh${rebase ? ', source meter reset' : ''}). Resetting baselines to prevent money spikes.`);
          if (this.lastReadingHour) {
            this.lastReadingHour.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingHour', this.lastReadingHour).catch(this.error);
          }
          if (this.lastReadingDay) {
            this.lastReadingDay.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingDay', this.lastReadingDay).catch(this.error);
          }
          if (this.lastReadingMonth) {
            this.lastReadingMonth.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingMonth', this.lastReadingMonth).catch(this.error);
          }
          if (this.lastReadingYear) {
            this.lastReadingYear.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingYear', this.lastReadingYear).catch(this.error);
          }
          if (this.meterMoney) this.meterMoney.meterValue = reading.meterValue;
        }
      }

      const periods = MeterHelpers.getPeriods(
        reading,
        this.lastReadingHour,
        this.lastReadingDay,
        this.lastReadingMonth,
        this.lastReadingYear,
        this.startDay,
        this.startMonth,
      );
      await this.updateMeters(reading, periods);
      await this.updateTargets(periods).catch((err) => this.error(err));
      await this.updateMoney(reading, periods);
    } catch (error) {
      this.error(error);
    }
  }

  // The usable capacity (kWh); the battery driver uses the learned one.
  capacityKwh() {
    return Number(this.getSettings().batCapacity) || 0;
  }

  async updateValue(val, cap) {
    try {
      if (cap === 'chargeMode') return;
      if (cap === 'soc') {
        this.soc = val;
        const storedkWh = val * (this.capacityKwh() / 100);
        await this.setCapability('meter_kwh_stored', storedkWh).catch((err) => this.error(err));
      }
      if (cap === 'power') {
        // Signed vendor capability; inverted when its convention is opposite to Homey's (+ = charging).
        const signedVal = this.sourcePowerInvert ? -val : val;
        await this.updateMeterFromMeasure(signedVal).catch((err) => this.error(err));
      }
      if (cap === 'chargePower') {
        // Non-negative magnitude capability: charging is always positive.
        await this.updateMeterFromMeasure(val).catch((err) => this.error(err));
      }
      if (cap === 'dischargePower') {
        // Non-negative magnitude capability: discharging is always negative.
        await this.updateMeterFromMeasure(-val).catch(this.error);
      }
      if (cap === 'newMeasurePower') {
        this.lastNewMeasurePower = val;
        await this.processNewMeasurePower();
      }
      if (cap === 'chargingState') {
        this.lastChargingState = val;
        await this.processNewMeasurePower();
      }
      if (cap === 'meterCharging' || cap === 'meterDischarging') {
        const charging = cap === 'meterCharging';
        const meterCap = charging ? 'meter_kwh_charging' : 'meter_kwh_discharging';
        if (!this.sourceMeterState) this.sourceMeterState = {};
        const switched = !!(this.switchRegisters && this.switchRegisters.delete(cap));
        // The first value of another source: no reset to wait for.
        const prev = switched ? { value: null } : (this.sourceMeterState[cap] || { value: this.getCapabilityValue(meterCap) });
        if (switched) this.shiftNextReading = true;
        const { state, use, rebase } = MeterHelpers.cumulativeReading(prev, val, Date.now());
        this.sourceMeterState[cap] = state;
        if (!use) return;
        if (rebase) {
          this.log(`${meterCap} reset ${prev.value} -> ${val}: new base, no money`);
          this.rebaseNextReading = true;
        }
        if (charging) this.lastMeterCharging = val;
        else this.lastMeterDischarging = val;
        if (this.hasCapability(meterCap)) await this.setCapability(meterCap, val).catch((err) => this.error(err));
        await this.processSourceMeters();
      }
    } catch (error) {
      this.error(error);
    }
  }

  async processNewMeasurePower() {
    let val = this.lastNewMeasurePower;
    if (typeof val !== 'number') return;

    if (this.lastChargingState) {
      val = Math.abs(val);
      if (this.lastChargingState === 'discharging') {
        val = -val;
      } else if (this.lastChargingState === 'idle') {
        val = 0;
      }
    }

    await this.updateMeterFromMeasure(val).catch((err) => this.error(err));
  }

  async processSourceMeters() {
    const charging = typeof this.lastMeterCharging === 'number' ? this.lastMeterCharging : this.getCapabilityValue('meter_kwh_charging') || 0;
    const discharging = typeof this.lastMeterDischarging === 'number' ? this.lastMeterDischarging : this.getCapabilityValue('meter_kwh_discharging') || 0;

    const netMeter = discharging - charging;
    await this.updateMeter(netMeter);
  }

  async updateMeter(val) {
    try {
      if (typeof val !== 'number') return;
      if (!this.migrated || this.currencyChanged) return;

      const reading = await this.getReadingObject(val);
      // firstReadingDone, not initReady: a reading after a failed init must not end its retry.
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

  // takes Watt, creates kWh meter value
  async updateMeterFromMeasure(val) {
    if (!this.migrated) return;
    const measureTm = new Date();
    const value = val;
    if (typeof value !== 'number') return;
    const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);

    const lastMeterValue = this.getCapabilityValue('meter_power_hidden');
    let lastChargingMeterValue = this.getCapabilityValue('meter_kwh_charging');
    let lastDischargingMeterValue = this.getCapabilityValue('meter_kwh_discharging');

    if (typeof lastMeterValue !== 'number') {
      this.error('lastMeterValue is NaN, WTF');
      return;
    }
    if (typeof deltaTm !== 'number' || deltaTm === 0) {
      this.error('deltaTm is NaN, WTF');
      return;
    }

    const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
    // Battery: the meter counts energy delivered to the home, so charging lowers it. A device that
    // only consumes (EV charger) sets measureAddsToMeter: charging raises it, as a kWh meter does.
    const meter = this.measureAddsToMeter ? lastMeterValue + deltaMeter : lastMeterValue - deltaMeter;

    const hasSourceMeters = this.sourceCapGroup && (this.sourceCapGroup.meterCharging || this.sourceCapGroup.meterDischarging);

    if (!hasSourceMeters) {
      if (deltaMeter < 0) {
        if (this.hasCapability('meter_kwh_discharging')) {
          lastDischargingMeterValue = (lastDischargingMeterValue || 0) - deltaMeter;
          await this.setCapability('meter_kwh_discharging', lastDischargingMeterValue).catch((err) => this.error(err));
        }
      } else if (this.hasCapability('meter_kwh_charging')) {
        lastChargingMeterValue = (lastChargingMeterValue || 0) + deltaMeter;
        await this.setCapability('meter_kwh_charging', lastChargingMeterValue).catch((err) => this.error(err));
      }
      await this.updateMeter(meter);
    }

    await this.setCapability('measure_watt_avg', value).catch((err) => this.error(err));
    this.lastMeasure = {
      value,
      measureTm,
    };
  }

  // meter_kwh_charging or _discharging at ms: now minus its growth since then (resets skipped). From
  // the source meter's log first (the source's own counter; this counter followed it only from
  // 2026-03-20), else its own log, else from the first value of either. null without any.
  // cache: a Map for several calls (logs and the source's values).
  async counterAt(api, cap, ms, cache = new Map()) {
    const ownNow = this.getCapabilityValue(cap);
    if (typeof ownNow !== 'number') return null;
    const srcCap = this.sourceCapGroup && this.sourceCapGroup[cap === 'meter_kwh_charging' ? 'meterCharging' : 'meterDischarging'];
    const srcId = this.getSettings().homey_device_id;
    let srcNow = null;
    if (srcCap && srcId) {
      if (!cache.has('source')) cache.set('source', await api.devices.getDevice({ id: srcId }).catch(() => null));
      const src = cache.get('source');
      srcNow = src && src.capabilitiesObj && src.capabilitiesObj[srcCap] ? src.capabilitiesObj[srcCap].value : null;
    }
    const tries = [
      typeof srcNow === 'number' ? [srcId, srcCap, srcNow, false] : null,
      [this.getId(), cap, ownNow, false],
      typeof srcNow === 'number' ? [srcId, srcCap, srcNow, true] : null,
      [this.getId(), cap, ownNow, true],
    ].filter(Boolean);
    for (const [id, c, nowValue, orFirst] of tries) {
      const grown = await ContractYear.growthSince(api, id, [c], ms, { nowValue, orFirst, cache }).catch(() => null);
      if (typeof grown === 'number') return ownNow - grown;
    }
    return null;
  }

  // Charged and discharged kWh per hour, day, month and year (capabilities meter_kwh_this_*.charged
  // and .discharged where the driver has them): each counter minus its value at the period start
  // (store counterReadings). A counter that drops (a reset at the source) keeps the period's count.
  async updateCounterPeriods(periods) {
    if (!this.hasCapability('meter_kwh_this_day.charged')) return;
    const now = { charged: this.getCapabilityValue('meter_kwh_charging'), discharged: this.getCapabilityValue('meter_kwh_discharging') };
    if (!this.counterReadings) this.counterReadings = this.getStoreValue('counterReadings') || {};
    if (!this.counterValues) this.counterValues = {};
    let changed = false;
    for (const period of COUNTER_PERIODS) {
      if (!this.counterReadings[period]) {
        this.counterReadings[period] = {};
        this.restoreCounterReadings().catch((err) => this.error(err));
      }
      const base = this.counterReadings[period];
      const isNew = periods[`new${period[0].toUpperCase()}${period.slice(1)}`];
      for (const kind of ['charged', 'discharged']) {
        if (typeof now[kind] !== 'number') continue;
        const key = `${period}.${kind}`;
        if (typeof base[kind] !== 'number') {
          base[kind] = now[kind];
          changed = true;
        }
        if (now[kind] < base[kind]) {
          base[kind] = now[kind] - (this.counterValues[key] || 0);
          changed = true;
        }
        const val = Math.round((now[kind] - base[kind]) * 10000) / 10000;
        this.counterValues[key] = val;
        if (isNew && period !== 'hour' && this.hasCapability(`meter_kwh_last_${period}.${kind}`)) {
          await this.setCapability(`meter_kwh_last_${period}.${kind}`, val).catch((err) => this.error(err));
        }
        if (this.hasCapability(`meter_kwh_this_${period}.${kind}`)) {
          await this.setCapability(`meter_kwh_this_${period}.${kind}`, isNew ? 0 : val).catch((err) => this.error(err));
        }
      }
      if (isNew) {
        this.counterReadings[period] = { ...now };
        COUNTER_KINDS.forEach((kind) => {
          this.counterValues[`${period}.${kind}`] = 0;
        });
        changed = true;
      }
    }
    if (changed) await this.setStoreValue('counterReadings', this.counterReadings);
  }

  async onPeriodsRebased() {
    await this.restoreCounterReadings(['month', 'year']);
    await ContractYear.serial(() => this.restoreLastCounters(['month', 'year'])).catch((err) => this.error(err));
  }

  // The charged and discharged kWh of the last periods, from Insights (counterAt()).
  async restoreLastCounters(periods) {
    let api = null;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;
    const starts = HistoryRestore.periodStarts(TimeHelpers.toLocalDate(new Date(), this.timeZone), this.startDay, this.startMonth, this.timeZone);
    const cache = new Map();
    for (const period of periods) {
      const [prevMs, ms] = starts[period];
      for (const [kind, cap] of [['charged', 'meter_kwh_charging'], ['discharged', 'meter_kwh_discharging']]) {
        const last = `meter_kwh_last_${period}.${kind}`;
        if (!this.hasCapability(last)) continue;
        const atStart = await this.counterAt(api, cap, ms, cache).catch(() => null);
        const atPrev = typeof atStart === 'number' ? await this.counterAt(api, cap, prevMs, cache).catch(() => null) : null;
        if (typeof atPrev === 'number') await this.setCapability(last, Math.round((atStart - atPrev) * 10000) / 10000).catch((err) => this.error(err));
      }
    }
  }

  // The counters at the period starts: from the source's or its own Insights (counterAt()). At
  // pairing, on a new contract start (month and year), and for a period without a start. One run
  // at a time: a call meanwhile shares it.
  async restoreCounterReadings(periods = COUNTER_PERIODS) {
    if (!this.hasCapability('meter_kwh_this_day.charged')) return undefined;
    if (this.counterRestore) return this.counterRestore;
    this.counterRestore = (async () => {
      await ContractYear.serial(() => this.restoreCounterReadingsNow(periods));
      // Shown now, not only at the next reading (an idle battery has none for hours).
      await this.updateCounterPeriods({
        newHour: false, newDay: false, newMonth: false, newYear: false,
      });
    })().finally(() => {
      this.counterRestore = null;
    });
    return this.counterRestore;
  }

  async restoreCounterReadingsNow(periods) {
    let api = null;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;
    const nowLocal = TimeHelpers.toLocalDate(new Date(), this.timeZone);
    const starts = MeterHelpers.periodStarts(nowLocal, this.startDay, this.startMonth);
    const ms = {
      hour: Math.floor(Date.now() / 3600000) * 3600000,
      day: ContractYear.localStartMs(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate()), this.timeZone),
      month: ContractYear.localStartMs(starts.month, this.timeZone),
      year: ContractYear.localStartMs(starts.year, this.timeZone),
    };
    const counters = [['charged', 'meter_kwh_charging'], ['discharged', 'meter_kwh_discharging']]
      .filter(([, cap]) => typeof this.getCapabilityValue(cap) === 'number');
    const readings = { ...(this.counterReadings || this.getStoreValue('counterReadings') || {}) };
    if (!this.counterValues) this.counterValues = {};
    const cache = new Map();
    for (const period of periods) {
      const reading = {};
      for (const [kind, cap] of counters) {
        const v = await this.counterAt(api, cap, ms[period], cache).catch(() => null);
        if (typeof v === 'number') reading[kind] = v;
      }
      // A partial result only fills a period without a start: the found and kept bases would differ.
      const existing = readings[period] || {};
      const complete = Object.keys(reading).length === counters.length;
      if (!Object.keys(reading).length || (!complete && Object.keys(existing).length)) continue;
      readings[period] = { ...existing, ...reading };
      COUNTER_KINDS.forEach((kind) => delete this.counterValues[`${period}.${kind}`]);
    }
    this.counterReadings = readings;
    await this.setStoreValue('counterReadings', readings);
    this.log(`${this.getName()}: counters at the period starts`, readings);
  }

  async updateMeters({ ...reading }, { ...periods }) {
    await this.setCapability('meter_power_hidden', reading.meterValue).catch((err) => this.error(err));
    await this.updatePeriodMeters(reading, periods);
    await this.updateCounterPeriods(periods).catch((err) => this.error(err));
    let lastReadingHour = { ...this.lastReadingHour };
    let lastReadingDay = { ...this.lastReadingDay };
    let lastReadingMonth = { ...this.lastReadingMonth };
    let lastReadingYear = { ...this.lastReadingYear };
    if (periods.newHour) {
      lastReadingHour = reading;
      await this.setStoreValue('lastReadingHour', reading);
    }
    if (periods.newDay) {
      lastReadingDay = reading;
      await this.setStoreValue('lastReadingDay', reading);
    }
    if (periods.newMonth) {
      lastReadingMonth = reading;
      await this.setStoreValue('lastReadingMonth', reading);
    }
    if (periods.newYear) {
      lastReadingYear = reading;
      await this.setStoreValue('lastReadingYear', reading);
    }
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
  }

  // kWh per hour/day/month/year, for drivers that declare them in this.ds.cmap (EV charger), from
  // the same period baselines as the money. Must run before updateMeters() moves the baselines.
  async updatePeriodMeters(reading, periods) {
    const cmap = this.ds && this.ds.cmap;
    if (!cmap || !cmap.this_day) return;
    const since = (base) => (base && typeof base.meterValue === 'number' ? Math.max(0, reading.meterValue - base.meterValue) : 0);
    const round = (v) => Math.round(v * 10000) / 10000;
    const parts = [
      ['hour', this.lastReadingHour, periods.newHour],
      ['day', this.lastReadingDay, periods.newDay],
      ['month', this.lastReadingMonth, periods.newMonth],
      ['year', this.lastReadingYear, periods.newYear],
    ];
    for (const [name, base, rolled] of parts) {
      if (rolled) {
        await this.setCapability(cmap[`last_${name}`], round(since(base))).catch((err) => this.error(err));
        await this.setCapability(cmap[`this_${name}`], 0).catch((err) => this.error(err));
      } else {
        await this.setCapability(cmap[`this_${name}`], round(since(base))).catch((err) => this.error(err));
      }
    }
  }

  async updateMoney({ ...reading }, { ...periods }) {
    const { prices, exportPrices } = this.pricesFromNow();
    const purchaseTariff = (prices && prices[0] !== undefined) ? prices[0] : (this.getCapabilityValue('meter_tariff') || 0);
    const exportTariff = (exportPrices && exportPrices[0] !== undefined) ? exportPrices[0] : purchaseTariff;

    // Tariff across a price-period boundary (MeterHelpers.getPeriodTariff()). Default is the live
    // pricesNextHours/exportTariff, which falls back to meter_tariff when a broadcast has no prices.
    const priceInterval = this.priceInterval || 60;
    const lastReadingTm = this.lastMoneyReadingTm || new Date(new Date(reading.meterTm).getTime() - 1000);
    const { tariff, exportTariff: expTariff } = MeterHelpers.getPeriodTariff(
      this.tariffHistory,
      priceInterval,
      reading.meterTm,
      lastReadingTm,
      { tariff: purchaseTariff, exportTariff },
      this.timeZone,
    );
    this.lastMoneyReadingTm = reading.meterTm;

    const activeTariff = MeterHelpers.getActiveTariff(
      this.getSettings(),
      this.currentGridPower,
      tariff,
      expTariff,
    );

    // Unknown grid power: purchaseTariff (discharging avoids a purchase).

    // meter_tariff is the tariff now: a delta across the boundary is paid at the previous one, the
    // capability does not go back to it.
    const nowTariff = MeterHelpers.getActiveTariff(this.getSettings(), this.currentGridPower, purchaseTariff, exportTariff);
    if (nowTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', nowTariff).catch((err) => this.error(err));

    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff);

    await this.rollMoneyPeriods(meterMoney, periods);

    await this.setCapability('meter_money_this_hour', meterMoney.hour);
    await this.setCapability('meter_money_this_day', meterMoney.day);
    await this.setCapability('meter_money_this_month', meterMoney.month);
    await this.setCapability('meter_money_this_year', meterMoney.year);
    this.meterMoney = meterMoney;
    await this.updateAvgMoney();
  }

  // Energy used against the budget so far (EV charger), as in generic_sum_device.js
  async updateTargets({ ...periods }) {
    const cmap = this.ds && this.ds.cmap;
    const { distribution, budget } = this.getSettings();
    if (!cmap || !cmap.this_year || !Budget.isActive(distribution, budget)) return;
    if (periods.newDay || !this.budgets) {
      this.budgets = Budget.getBudgetsToDate({
        distribution, budget, timeZone: this.timeZone, startDay: this.startDay, startMonth: this.startMonth,
      });
    }
    if (this.budgets && this.budgets.yearToDate) {
      await this.setCapability('meter_target_year_to_date', 100 * (this.getCapabilityValue(cmap.this_year) / this.budgets.yearToDate));
    }
    if (this.budgets && this.budgets.monthToDate) {
      await this.setCapability('meter_target_month_to_date', 100 * (this.getCapabilityValue(cmap.this_month) / this.budgets.monthToDate));
    }
  }

  // Average price per kWh this month/year, for drivers with kWh period meters (EV charger).
  async updateAvgMoney() {
    const cmap = this.ds && this.ds.cmap;
    if (!cmap || !cmap.this_month) return;
    const kwhMonth = this.getCapabilityValue(cmap.this_month);
    const kwhYear = this.getCapabilityValue(cmap.this_year);
    if (kwhMonth) await this.setCapability('meter_money_this_month_avg', this.meterMoney.month / kwhMonth);
    if (kwhYear) await this.setCapability('meter_money_this_year_avg', this.meterMoney.year / kwhYear);
  }

}

Object.assign(BatDevice.prototype, MeterDeviceMixin);
BatDevice.MAX_METER_JUMP_KWH = MAX_METER_JUMP_KWH;

module.exports = BatDevice;
