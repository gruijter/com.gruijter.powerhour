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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const LoadForecastStrategy = require('../../lib/strategies/LoadForecastStrategy');
const GridFlows = require('../../lib/flows/GridFlows');
const { getGridForecastChart, getGridWeeklyChart } = require('../../lib/charts/GridChart');
const MeterHelpers = require('../../lib/helpers/MeterHelpers');
const GridConnection = require('../../lib/helpers/GridConnection');
const FuseGuard = require('../../lib/strategies/FuseGuard');
const DeviceMigrator = require('../../lib/DeviceMigrator');
const ChartImages = require('../../lib/helpers/ChartImages');
const { setTimeoutPromise } = require('../../lib/helpers/Util');
const { fetchYesterdayAndToday, convertCumulativeToPower, mergeStoredHistory } = require('../../lib/helpers/HistoryLookup');
const { combineComponentsToHomePower } = require('../../lib/helpers/HomePowerReconstruction');
const InsightsHistory = require('../../lib/helpers/InsightsHistory');
const FileStore = require('../../lib/helpers/FileStore');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const LoadSpread = require('../../lib/helpers/LoadSpread');
const PeakTariff = require('../../lib/strategies/PeakTariff');

// Power per phase of the source (W): signed like measure_power, + import (verified live on Sessy P1
// and Enelogic LS120, HomeWizard P1 by its API docs v2).
const PHASE_CAPS = ['measure_power.l1', 'measure_power.l2', 'measure_power.l3'];
const PHASE_HISTORY_MS = 90 * 1000;
// Only L1 above 0 this long: a 1-phase connection (a 3-phase home always uses some power per phase).
const PHASE_CHECK_MS = 60 * 60 * 1000;

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_kwh_this_hour',
    last_hour: 'meter_kwh_last_hour',
    this_day: 'meter_kwh_this_day',
    last_day: 'meter_kwh_last_day',
    this_month: 'meter_kwh_this_month',
    last_month: 'meter_kwh_last_month',
    this_year: 'meter_kwh_this_year',
    last_year: 'meter_kwh_last_year',
    // Hidden internal meter for the base class's accounting, as in the battery/evCharger drivers.
    meter_source: 'meter_power_hidden.grid',
    measure_source: 'measure_watt_grid',
    minMaxPrefix: 'measure_watt',
  },
};

class GridDevice extends GenericDevice {
  async onInit() {
    this.startupTime = Date.now();
    this.ds = deviceSpecifics;
    this.flows = new GridFlows(this);

    const files = await FileStore.open(this, ['powerHistory', 'netForecastHistory', 'forecastErrors']);
    // Before super.onInit(): its first poll records samples (mergeStoredHistory).
    let history = files.get('powerHistory');
    if (!Array.isArray(history)) history = [];
    const ceilingW = this.getHomePowerCeilingW();
    const storedHistory = history
      .map((e) => {
        const time = e.time || (e.t ? new Date(e.t).getTime() : Date.now());
        let power = 0;
        if (typeof e.power === 'number') power = e.power;
        else if (typeof e.v === 'number') power = e.v;
        else if (typeof e.y === 'number') power = e.y;
        return { time, power, grid: typeof e.grid === 'number' ? e.grid : null };
      })
      .filter((e) => e.power >= 0 && e.power <= ceilingW);
    this.powerHistory = mergeStoredHistory(storedHistory, this.powerHistory, 2880);

    // Grid forecast per slot as it was when the slot started (battery/EV plans are not kept).
    const netForecastHistory = files.get('netForecastHistory');
    this.netForecastHistory = mergeStoredHistory(netForecastHistory, this.netForecastHistory, 200);

    // Before super.onInit(): it sets initReady partway, after which chart updates may run.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    // Restored before super.onInit(): its first poll already reaches handleUpdateMeter(); without
    // the anchors it would re-bootstrap and zero this_* imported/exported and splitMoney.
    const book = await this.restoreBookkeeping();
    // Per-direction register state for the 'perDirection'/'fixedBlock' schemes.
    this.directionalMeter = book.directionalMeter || { importValue: null, exportValue: null };
    this.lastDirectionalSnapshot = book.lastDirectionalSnapshot;
    this.directionalPseudoState = book.directionalPseudoState;
    this.directionalBlockState = book.directionalBlockState;

    // Lazily bootstrapped on the first tick (updateSplitMeters()/updateSplitMoney()).
    this.lastDirectionalReadingDay = book.lastDirectionalReadingDay;
    this.lastDirectionalReadingMonth = book.lastDirectionalReadingMonth;
    this.lastDirectionalReadingYear = book.lastDirectionalReadingYear;
    this.splitMoney = book.splitMoney;

    // Capacity-tariff peak state (updatePeakLoad()), lazily bootstrapped.
    this.peakLoad = book.peakLoad;
    this.lastPeakLoadReading = book.lastPeakLoadReading;
    // Stored, so a restart mid-slot does not fire peak_projected_exceeded again.
    this.peakExceededSlot = await this.getStoreValue('peakExceededSlot');
    // Capacity tariff: this month's closed windows (PeakTariff.recordWindow()).
    this.peakHistory = book.peakHistory;
    this.meterPowerHome = book.meterPowerHome || 0;
    this.peakConfig = PeakTariff.configFromSettings(this.getSettings());

    // A repair can re-point this device at another meter (new homey_device_id). The anchors above
    // diff the old meter's registers: drop them, or the first tick books one huge bogus delta (and
    // a peak that sticks all year). Checked here, as setSettings() does not call onSettings() (SDK).
    const boundSourceId = await this.getStoreValue('directionalSourceId');
    const sourceId = this.getSettings().homey_device_id;
    if (boundSourceId && boundSourceId !== sourceId) {
      this.log(`Source device changed (${boundSourceId} -> ${sourceId}) - re-anchoring import/export and peak-load state`);
      await this.reanchorExtraBaselines();
    }
    if (boundSourceId !== sourceId) await this.setStoreValue('directionalSourceId', sourceId).catch(this.error);

    await super.onInit().catch(this.error);

    // A newer onInit() may have started meanwhile: the loops below must not be started twice.
    const sessionIdAfterSuper = this.sessionId;

    // Migrate the old 'enableDirectionalNetting' boolean once. A store flag, not an undefined
    // check: Homey fills in the new setting's default before onInit().
    if (!(await this.getStoreValue('directionalSchemeMigrated'))) {
      const s = this.getSettings();
      if (typeof s.enableDirectionalNetting === 'boolean') {
        const migrated = s.enableDirectionalNetting ? 'perDirection' : 'continuousNet';
        if (s.directionalNettingScheme !== migrated) {
          await this.setSettings({ directionalNettingScheme: migrated }).catch(this.error);
        }
      }
      await this.setStoreValue('directionalSchemeMigrated', true).catch(this.error);
    }
    // 'off' is no longer a scheme value.
    if (this.getSettings().directionalNettingScheme === 'off') {
      await this.setSettings({ directionalNettingScheme: 'continuousNet' }).catch(this.error);
    }

    // Legacy comparison capabilities.
    for (const cap of ['meter_money_this_hour_directional', 'meter_money_this_day_directional',
      'meter_money_this_month_directional', 'meter_money_this_year_directional']) {
      if (this.hasCapability(cap)) {
        this.log(`Removing obsolete capability ${cap} from device ${this.getName()}`);
        await this.removeCapability(cap).catch(this.error);
        await setTimeoutPromise(2 * 1000, this);
      }
    }

    await this.updatePeakLoadCapabilityTitles().catch(this.error);

    this.timeZone = this.homey.clock.getTimezone();
    await this.applyPeakSettingsChange().catch(this.error);
    await this.seedPeakHistory().catch(this.error);
    const storedProfile = await this.getStoreValue('weeklyProfile');
    this.weeklyProfile = storedProfile || LoadForecastStrategy.initializeProfile();
    this.lastAutoRetrainLoad = await this.getStoreValue('lastAutoRetrainLoad') || 0;
    this.retrainingLoad = false;
    this.forecastErrors = (await FileStore.open(this)).get('forecastErrors') || [];
    this.plannedLoads = await this.getStoreValue('plannedLoads') || [];
    await this.updateForecastAccuracyStatus().catch(this.error);

    this.retrainLoadListener = this.registerCapabilityListener('button.retrain_load', async () => {
      await this.retrainLoadModel(true);
      return true;
    });

    if (this.sessionId !== sessionIdAfterSuper) return; // superseded by a newer onInit()
    this.startForecastLoop().catch(this.error);
    if (this.initLearningTimeout) this.homey.clearTimeout(this.initLearningTimeout);
    const finishInit = async () => {
      await this.populatePowerHistory();
      await this.updateForecastDisplay().catch(this.error);
      if (!storedProfile) {
        await this.attemptInitialBackfill();
      }
      this.startLearningLoop().catch(this.error);
      this.initLearningTimeout = null;
    };
    this.initLearningTimeout = this.homey.setTimeout(() => {
      finishInit().catch(this.error);
    }, 15000);
  }

  // The app API may still be connecting after pairing, and retrainLoadModel() swallows "API not
  // ready": retry, or a device paired then never gets its one-time Insights backfill.
  async attemptInitialBackfill(attempt = 1) {
    const maxAttempts = 5;
    const retryDelayMs = 30000;
    let api;
    try {
      api = this.homey.app.api;
    } catch { }
    if (!api) {
      if (attempt >= maxAttempts) {
        this.error(`[attemptInitialBackfill] Homey API still not ready after ${maxAttempts} attempts, `
          + 'giving up. Weekly profile will build up via live learning instead.');
        return;
      }
      this.log(`[attemptInitialBackfill] Homey API not ready yet (attempt ${attempt}/${maxAttempts}), `
        + `retrying in ${retryDelayMs / 1000}s...`);
      if (this.initialBackfillRetryTimeout) this.homey.clearTimeout(this.initialBackfillRetryTimeout);
      this.initialBackfillRetryTimeout = this.homey.setTimeout(() => {
        this.initialBackfillRetryTimeout = null;
        this.attemptInitialBackfill(attempt + 1).catch(this.error);
      }, retryDelayMs);
      return;
    }
    this.log('First initialization: Auto-starting load model retraining...');
    await this.retrainLoadModel(true);
  }

  async initDeviceValues() {
    if (typeof this.meterPowerHome !== 'number') this.meterPowerHome = 0; // restoreBookkeeping()
    if (this.hasCapability('meter_power_hidden.home')) {
      await this.setCapabilityValue('meter_power_hidden.home', this.meterPowerHome).catch(this.error);
    }
    await super.initDeviceValues();
  }

  // A scheme switch resets the running this_* money buckets so two methods are not blended;
  // last_* and the raw register state are kept. super.onSettings() restarts the device.
  async onSettings({ newSettings, changedKeys }) {
    const peakReason = PeakTariff.invalidReason(newSettings);
    if (peakReason) throw Error(this.homey.__(peakReason));
    // Applied after the restart (applyPeakSettingsChange()): Homey refuses setSettings now.
    if (changedKeys.includes('peakPreset')) this.peakSettingsPending = { preset: newSettings.peakPreset };
    else if (PeakTariff.leavesPreset(newSettings.peakPreset, changedKeys)) {
      this.peakSettingsPending = { custom: true };
    }
    if (changedKeys.includes('directionalNettingScheme')) {
      this.meterMoney = {
        ...this.meterMoney,
        hour: 0,
        day: 0,
        month: 0,
        year: 0,
      };
      this.fixedMoney = { month: 0, year: 0 };
      await this.setStoreValue('fixedMoney', this.fixedMoney).catch((err) => this.error(err));
      this.directionalBlockState = null;
      this.lastDirectionalSnapshot = null;
      // Forced flush, so a dirty mark from the last tick cannot write the old state back.
      this.markStoreDirty('directionalBlockState');
      this.markStoreDirty('lastDirectionalSnapshot');
      await this.flushDirtyStore({ force: true });
      for (const cap of ['meter_money_this_hour', 'meter_money_this_day',
        'meter_money_this_month', 'meter_money_this_year',
        'meter_money_this_month_avg', 'meter_money_this_year_avg']) {
        await this.setCapability(cap, 0).catch(this.error);
      }
    }
    if (changedKeys.includes('peakLoadIntervalMinutes')) {
      this.resetPeakWindow();
      await this.flushDirtyStore({ force: true }); // the restart reads peakLoad from the store
      await this.updatePeakLoadCapabilityTitles().catch(this.error);
    }
    return super.onSettings({ newSettings, changedKeys });
  }

  async setCapability(capability, value) {
    await super.setCapability(capability, value);
    if (capability === 'measure_watt_grid') {
      const nowMs = Date.now();
      if (this.gridPowerTm) this.gridIntervalMs = FuseGuard.readingInterval(this.gridIntervalMs, nowMs - this.gridPowerTm);
      this.gridPowerTm = nowMs;
      // Contained: must never stop the power update itself.
      try {
        this.recordPhasePower(nowMs);
        this.checkFuseOverload(this.gridPowerTm);
      } catch (err) {
        this.error('[Fuse]', err);
      }
      try {
        this.checkPhaseSetup(nowMs);
      } catch (err) {
        this.error('[Fuse]', err);
      }
      this.calculateHomePower().catch(this.error);
    }
  }

  async calculateHomePower() {
    try {
      const gridPower = this.getCapabilityValue('measure_watt_grid') || 0;

      let solarPower = 0;
      let hasPbthSolar = false;
      const solarDriver = this.homey.drivers.getDriver('solar');
      if (solarDriver) {
        const solarDevices = solarDriver.getDevices();
        if (solarDevices && solarDevices.length > 0) {
          hasPbthSolar = true;
          solarDevices.forEach((dev) => {
            solarPower += (dev.getCapabilityValue('measure_power') || 0);
          });
        }
      }

      // Fallback to Homey Energy when there are no PbtH solar devices
      if (!hasPbthSolar) {
        const report = this.driver.lastEnergyReport;
        if (report && report.totalGenerated && typeof report.totalGenerated.W === 'number') {
          solarPower = report.totalGenerated.W;
        }
      }

      let batteryPower = 0;
      const batDriver = this.homey.drivers.getDriver('battery');
      if (batDriver) {
        batDriver.getDevices().forEach((dev) => {
          batteryPower += (dev.getCapabilityValue('measure_watt_avg') || 0);
        });
      }

      let evPower = 0;
      const evDriver = this.homey.drivers.getDriver('evCharger');
      if (evDriver) {
        evDriver.getDevices().forEach((dev) => {
          evPower += (dev.getCapabilityValue('measure_watt_avg') || 0);
        });
      }

      await this.setCapability('measure_watt_solar', Math.round(solarPower)).catch(this.error);
      await this.setCapability('measure_watt_battery', Math.round(batteryPower)).catch(this.error);
      await this.setCapability('measure_watt_evcharger', Math.round(evPower)).catch(this.error);

      // Home = grid (+ import) + solar - battery (+ charging) - EV
      const homePower = Math.round(gridPower + solarPower - batteryPower - evPower);

      // 2-minute rolling average: grid, battery and solar report at different moments, which
      // gives spikes when the battery switches direction.
      const now = Date.now();
      if (!Array.isArray(this.homePowerBuffer)) this.homePowerBuffer = [];
      // A negative result is a timing skew, not a reading: count it as 0 (skipping it biases the
      // average upward). Above the ceiling a sample is implausible and skipped.
      const ceilingW = this.getHomePowerCeilingW();
      if (homePower <= ceilingW) {
        this.homePowerBuffer.push({ time: now, value: Math.max(0, homePower), grid: gridPower });
      }
      this.homePowerBuffer = this.homePowerBuffer.filter((e) => now - e.time <= 2 * 60 * 1000);
      const smoothedHomePower = this.homePowerBuffer.length > 0
        ? Math.round(this.homePowerBuffer.reduce((sum, e) => sum + e.value, 0) / this.homePowerBuffer.length)
        : Math.max(0, homePower);
      const safeHomePower = Math.max(0, Math.min(ceilingW, smoothedHomePower));
      const smoothedGridPower = this.homePowerBuffer.length > 0
        ? Math.round(this.homePowerBuffer.reduce((sum, e) => sum + e.grid, 0) / this.homePowerBuffer.length)
        : Math.round(gridPower);
      await this.setCapability('measure_watt_home', safeHomePower).catch(this.error);

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      if (typeof safeHomePower === 'number' && safeHomePower >= 0 && safeHomePower <= ceilingW) {
        const lastEntry = this.powerHistory[this.powerHistory.length - 1];
        // One entry per 5 minutes: the 576-entry cap is 48 h at that spacing.
        if (!lastEntry || (now - lastEntry.time) > 5 * 60 * 1000) {
          this.powerHistory.push({ time: now, power: safeHomePower, grid: smoothedGridPower });
          if (this.powerHistory.length > 576) this.powerHistory.shift();
          if (!this.lastPowerHistorySaveTm || (now - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
            this.fileStore.set('powerHistory', this.powerHistory);
            this.lastPowerHistorySaveTm = now;
          }
        }
      }
      if (this.lastHomePowerCalcTm) {
        const dt = now - this.lastHomePowerCalcTm;
        if (dt > 0 && dt < 300000) {
          const safePower = Math.max(0, this.lastHomePower || 0);
          const deltaKwh = (safePower * dt) / 3600000000;
          this.meterPowerHome = (this.meterPowerHome || 0) + deltaKwh;
          await this.setCapability('meter_power_hidden.home', Number(this.meterPowerHome.toFixed(4))).catch(this.error);
          this.markStoreDirty('meterPowerHome'); // stored with the bookkeeping (flushDirtyStore())
        }
      }
      this.lastHomePower = safeHomePower;
      this.lastHomePowerCalcTm = now;
    } catch (err) {
      this.error('Error calculating home power:', err);
    }
  }

  // super's 'dynamic' fallback reads this.currentGridPower, which is never set; use the live
  // measure_source instead when it would be reached.
  getActiveTariff(reading, tariff, exportTariff) {
    const tariffType = this.getSettings()?.tariff_type || 'dynamic';
    if (tariffType !== 'dynamic') return super.getActiveTariff(reading, tariff, exportTariff);

    let deltaMeter;
    if (this.meterMoney && typeof this.meterMoney.meterValue === 'number' && typeof reading.meterValue === 'number') {
      deltaMeter = reading.meterValue - this.meterMoney.meterValue;
    }
    if (typeof deltaMeter === 'number' && deltaMeter !== 0) {
      return super.getActiveTariff(reading, tariff, exportTariff);
    }

    const livePower = this.getCapabilityValue(this.ds.cmap.measure_source);
    if (typeof livePower === 'number') return livePower < 0 ? exportTariff : tariff;
    return tariff;
  }

  async addListeners() {
    await super.addListeners();
    await this.addPhaseListeners();
  }

  // A phase counts once it read other than 0: a 1-phase meter can report 0 on L2 and L3.
  async addPhaseListeners() {
    this.phaseW = null;
    const src = this.sourceDevice;
    if (!src || !PHASE_CAPS.every((c) => (src.capabilities || []).includes(c))) return;
    this.phaseW = PHASE_CAPS.map((c) => {
      const v = src.capabilitiesObj && src.capabilitiesObj[c] && src.capabilitiesObj[c].value;
      return typeof v === 'number' ? v : null;
    });
    this.phaseSeen = this.phaseW.map((v) => typeof v === 'number' && v !== 0);
    this.phaseListenTm = Date.now();
    for (let i = 0; i < PHASE_CAPS.length; i += 1) {
      this.capabilityInstances[`phase${i + 1}`] = await src.makeCapabilityInstance(PHASE_CAPS[i], (value) => {
        if (typeof value !== 'number' || !this.phaseW) return;
        this.phaseW[i] = value;
        if (value !== 0) this.phaseSeen[i] = true;
      });
    }
    this.log(`registering ${PHASE_CAPS.join(', ')} capability listeners for ${src.name}`);
  }

  async addSourceCapGroup() {
    // Diagnostic (forum #4048, HomeWizard P1): which energy field holds the imported/exported keys.
    this.log(`${this.sourceDevice.name} energy data:`, JSON.stringify({
      energyObj: this.sourceDevice.energyObj, energy: this.sourceDevice.energy,
    }));
    await super.addSourceCapGroup();

    // A repair can re-map the meter capabilities of the same source device (e.g. P1 net ->
    // consumed/returned): the stored anchors then diff another register. Devices from before the
    // setup view have no stored group; autoSourceCapGroup() reproduces theirs.
    const capKey = (group) => ['p1', 'p2', 'n1', 'n2'].map((k) => (group && group[k]) || '').join('|');
    const groupKey = capKey(this.sourceCapGroup);
    let boundKey = await this.getStoreValue('directionalSourceCaps');
    if (typeof boundKey !== 'string') boundKey = capKey(this.driver.autoSourceCapGroup(this.sourceDevice));
    if (boundKey !== groupKey) {
      this.log(`Source capabilities changed (${boundKey} -> ${groupKey}) - re-anchoring import/export and peak-load state`);
      await this.reanchorExtraBaselines();
    }
    if (await this.getStoreValue('directionalSourceCaps') !== groupKey) {
      await this.setStoreValue('directionalSourceCaps', groupKey).catch(this.error);
    }
  }

  // --- Settlement scheme ('directionalNettingScheme': continuousNet / perDirection / fixedBlock)
  // It drives meter_money_this_*. Registers are updated before super.handleUpdateMeter(), so
  // getMoneyDeltaOverride() sees this tick's values. Background: zzz_export_import_netting_research_and_plan.md.

  // Here and not in updateGroupMeter(): handleUpdateMeter() runs serialized, one reading at a
  // time, while p1/n1 updates can reach updateGroupMeter() concurrently.
  async handleUpdateMeter(reading) {
    if (typeof this.directionalLastWatt === 'number') {
      // case 3: pseudo registers from the last signed watt value
      await this.integrateDirectionalFromSignedPower(this.directionalLastWatt).catch((err) => this.error(err));
    } else {
      // case 1: real p1/n1 registers
      await this.updateDirectionalRegisters(this.lastGroupMeter.p1, this.lastGroupMeter.n1).catch((err) => this.error(err));
    }

    // Resolved once per tick; getMoneyDeltaOverride() uses this cached result (a second call
    // would see the advanced snapshot and under-count).
    this._directionalTickDelta = await this.resolveDirectionalDelta().catch((err) => {
      this.error(err);
      return null;
    });

    // Needs import only, so it also works without export data (the common capacity-tariff case).
    if (typeof this.directionalMeter?.importValue === 'number') {
      await this.updatePeakLoad(reading).catch((err) => this.error(err));
      await this.updatePeakProjection(reading).catch((err) => this.error(err));
    }

    // Only with export data (not case 2).
    const splitActive = typeof this.directionalMeter?.exportValue === 'number';
    const periods = this.getPeriods(reading);
    if (splitActive) {
      await this.updateSplitMeters(periods).catch((err) => this.error(err));
      await this.updateSplitMoney(periods).catch((err) => this.error(err));
    }

    await super.handleUpdateMeter(reading);
    this._directionalTickDelta = null;

    // Throttled store flush (see flushDirtyStore()), forced on a period boundary.
    const boundary = periods.newHour || periods.newDay || periods.newMonth || periods.newYear;
    await this.flushDirtyStore({ force: boundary }).catch((err) => this.error(err));
  }

  // Case 1 and case 3 never both apply to one device, so caching the watt value is safe.
  async updateMeterFromMeasure(val) {
    if (typeof val === 'number') this.directionalLastWatt = val;
    return super.updateMeterFromMeasure(val);
  }

  // Case 3 (no cumulative register): pseudo import/export registers integrated from the sign of
  // measure_power (+ import, - export).
  async integrateDirectionalFromSignedPower(value) {
    const nowTm = Date.now();
    if (!this.directionalPseudoState) {
      this.directionalPseudoState = { lastTm: nowTm, importTotal: 0, exportTotal: 0 };
      this.markStoreDirty('directionalPseudoState');
      return;
    }
    const deltaTm = nowTm - this.directionalPseudoState.lastTm;
    if (!(deltaTm > 0)) return;
    const deltaKwh = (Math.abs(value) * deltaTm) / 3600000000;
    if (value > 0) this.directionalPseudoState.importTotal += deltaKwh;
    else if (value < 0) this.directionalPseudoState.exportTotal += deltaKwh;
    this.directionalPseudoState.lastTm = nowTm;
    this.markStoreDirty('directionalPseudoState');
    await this.updateDirectionalRegisters(this.directionalPseudoState.importTotal, this.directionalPseudoState.exportTotal);
  }

  // --- Throttled persistence of the per-reading bookkeeping (at most once per STORE_FLUSH_MS), all
  // in one store value: every setStoreValue() sends the whole store (SDK), so one write per flush.
  // One write also keeps accumulators and the anchors they advance from consistent over a crash.
  static BOOKKEEPING_KEY = 'bookkeeping';

  static BOOKKEEPING_KEYS = [
    'directionalPseudoState', 'peakLoad', 'peakHistory', 'splitMoney', 'directionalBlockState',
    'directionalMeter', 'lastDirectionalSnapshot', 'lastPeakLoadReading',
    'lastDirectionalReadingDay', 'lastDirectionalReadingMonth', 'lastDirectionalReadingYear', 'meterPowerHome',
  ];

  // The bookkeeping as stored: { key: value } for BOOKKEEPING_KEYS. Earlier versions stored a value
  // per key: those move into the one value here (stored first, then the old keys removed).
  async restoreBookkeeping() {
    // A device restart: what is in memory is newer than the store.
    if (this.bookkeepingRestored) await this.flushDirtyStore({ force: true });
    const keys = GridDevice.BOOKKEEPING_KEYS;
    const stored = this.getStoreValue(GridDevice.BOOKKEEPING_KEY);
    const book = {};
    keys.forEach((key) => {
      const value = stored ? stored[key] : this.getStoreValue(key);
      book[key] = value === undefined ? null : value;
    });
    const legacy = keys.filter((key) => this.getStoreKeys().includes(key));
    if (legacy.length > 0) {
      // The old keys only go once the one value is stored.
      const saved = stored || await this.setStoreValue(GridDevice.BOOKKEEPING_KEY, book).then(() => true, (err) => {
        this.error(err);
        return false;
      });
      if (saved) {
        for (const key of legacy) await this.unsetStoreValue(key).catch(this.error);
        this.log(`Bookkeeping moved into one store value: ${legacy.join(', ')}`);
      }
    }
    this.bookkeepingRestored = true;
    return book;
  }

  // Each key is held on an instance property of the same name.
  markStoreDirty(key) {
    if (!this.dirtyStore) this.dirtyStore = new Set();
    this.dirtyStore.add(key);
  }

  // force: skip the throttle (period boundary, shutdown).
  async flushDirtyStore({ force = false } = {}) {
    // A flush writes every key: never before they are restored.
    if (!this.bookkeepingRestored || !this.dirtyStore || this.dirtyStore.size === 0) return;
    const nowTm = Date.now();
    if (!force && this.lastStoreFlushTm && (nowTm - this.lastStoreFlushTm) <= GenericDevice.STORE_FLUSH_MS) return;
    this.lastStoreFlushTm = nowTm;
    this.dirtyStore.clear();
    const book = {};
    GridDevice.BOOKKEEPING_KEYS.forEach((key) => {
      book[key] = this[key] === undefined ? null : this[key];
    });
    await this.setStoreValue(GridDevice.BOOKKEEPING_KEY, book).catch((err) => this.error(err));
  }

  async flushStore() {
    await this.flushDirtyStore({ force: true }).catch((err) => this.error(err));
    return super.flushStore();
  }

  // See generic_sum_device.js#reanchorExtraBaselines(). Drops every anchor on the source's raw
  // import/export registers so each re-bootstraps on the next tick. directionalMeter is cleared
  // too, or an old exportValue keeps splitActive on for an import-only new meter.
  // Kept: directionalPseudoState (only its deltas matter), period totals and peaks.
  async reanchorExtraBaselines() {
    this.directionalMeter = { importValue: null, exportValue: null };
    this.lastDirectionalSnapshot = null;
    this.lastDirectionalReadingDay = null;
    this.lastDirectionalReadingMonth = null;
    this.lastDirectionalReadingYear = null;
    this.lastPeakLoadReading = null;
    this._directionalTickDelta = null;
    // Through the flush, forced, so no earlier dirty mark can restore a pre-reanchor value.
    ['directionalMeter', 'lastDirectionalSnapshot', 'lastPeakLoadReading',
      'lastDirectionalReadingDay', 'lastDirectionalReadingMonth', 'lastDirectionalReadingYear',
    ].forEach((key) => this.markStoreDirty(key));
    await this.flushDirtyStore({ force: true });
  }

  // Case 1: real registers, case 3: pseudo registers. Case 2 (import only) never gets an
  // exportValue, so getMoneyDeltaOverride() keeps the base calculation.
  async updateDirectionalRegisters(importValue, exportValue) {
    if (!this.directionalMeter) this.directionalMeter = { importValue: null, exportValue: null };
    if (typeof importValue === 'number') this.directionalMeter.importValue = importValue;
    if (typeof exportValue === 'number') this.directionalMeter.exportValue = exportValue;
    this.markStoreDirty('directionalMeter');
  }

  // 'fixedBlock' only. 'auto' follows this device's price interval.
  getDirectionalBlockMinutes() {
    const setting = this.getSettings().directionalBlockMinutes;
    if (!setting || setting === 'auto') return this.priceInterval || 60;
    const n = Number(setting);
    return [15, 30, 45, 60].includes(n) ? n : (this.priceInterval || 60);
  }

  // Capacity-tariff averaging window; independent of the block size above.
  getPeakLoadIntervalMinutes() {
    const setting = this.getSettings().peakLoadIntervalMinutes;
    const n = Number(setting);
    return [15, 30, 60].includes(n) ? n : 15;
  }

  // Own setting, not GridConnection.limitW() (which resolves across all grid devices).
  getConnectionLimitW() {
    return GridConnection.limitFromSettings(this.getSettings());
  }

  // Plausibility ceiling for the home load: see GridConnection's PLAUSIBILITY_FACTOR.
  getHomePowerCeilingW() {
    return this.getConnectionLimitW() * GridConnection.PLAUSIBILITY_FACTOR;
  }

  // Puts the averaging window in the peak capability titles. Built from the manifest title, so
  // repeated calls do not stack the prefix.
  async updatePeakLoadCapabilityTitles() {
    const intervalMinutes = this.getPeakLoadIntervalMinutes();
    const minUnit = { ru: 'мин', ar: 'د' };
    const manifestOptions = this.driver.manifest.capabilitiesOptions || {};
    const wanted = {};
    [
      'measure_watt_peak.day', 'measure_watt_peak.month', 'measure_watt_peak.year', 'measure_watt_peak.billed',
      'measure_watt_peak_export.day', 'measure_watt_peak_export.month', 'measure_watt_peak_export.year',
    ].forEach((capId) => {
      const baseTitle = (manifestOptions[capId] || {}).title || {};
      const title = {};
      Object.keys(baseTitle).forEach((locale) => {
        title[locale] = `${intervalMinutes} ${minUnit[locale] || 'min'} ${baseTitle[locale]}`;
      });
      wanted[capId] = { title };
    });
    await DeviceMigrator.syncCapabilityOptions(this, wanted);
  }

  // Raw import/export delta since the last tick, advancing lastDirectionalSnapshot. Call once per
  // tick only (see handleUpdateMeter()). null: nothing to report.
  async resolveDirectionalDelta() {
    const { importValue, exportValue } = this.directionalMeter || {};
    if (typeof importValue !== 'number' || typeof exportValue !== 'number') return null;
    if (!this.tariffHistory || typeof this.tariffHistory.current !== 'number') return null;

    const now = new Date();

    if (!this.lastDirectionalSnapshot) {
      this.lastDirectionalSnapshot = { importValue, exportValue, tm: now.getTime() };
      this.markStoreDirty('lastDirectionalSnapshot');
      return null;
    }

    const deltaImport = importValue - this.lastDirectionalSnapshot.importValue;
    const deltaExport = exportValue - this.lastDirectionalSnapshot.exportValue;
    if (!Number.isFinite(deltaImport) || !Number.isFinite(deltaExport)) return null;
    if (deltaImport === 0 && deltaExport === 0) return null;

    const lastTm = this.lastDirectionalSnapshot.tm;
    this.lastDirectionalSnapshot = { importValue, exportValue, tm: now.getTime() };
    this.markStoreDirty('lastDirectionalSnapshot');

    return {
      deltaImport, deltaExport, now, lastTm, importValue, exportValue,
    };
  }

  // Hook for generic_sum_device.js#updateMoney(): null = base net calculation ('continuousNet'),
  // a number = this tick's deltaMoney.
  async getMoneyDeltaOverride() {
    const scheme = this.getSettings().directionalNettingScheme || 'perDirection';
    if (scheme === 'continuousNet') return null;
    if (typeof this.directionalMeter?.exportValue !== 'number') return null;

    const resolved = this._directionalTickDelta;
    if (!resolved) return 0;
    const {
      deltaImport, deltaExport, now, lastTm,
    } = resolved;

    if (scheme === 'fixedBlock') {
      return this.computeFixedBlockDeltaMoney(deltaImport, deltaExport, now);
    }
    // 'perDirection': price each direction separately, never net.
    const priceInterval = this.priceInterval || 60;
    const { tariff: effImportTariff, exportTariff: effExportTariff } = MeterHelpers.getPeriodTariff(
      this.tariffHistory,
      priceInterval,
      now,
      lastTm,
      undefined,
      this.timeZone,
    );
    return (deltaImport * effImportTariff) - (deltaExport * effExportTariff);
  }

  // Physical import/export kWh per day/month/year, independent of the scheme. Same anchor-diff
  // method and period flags as the base net totals, so both cover the same span.
  async updateSplitMeters(periods) {
    const { importValue, exportValue } = this.directionalMeter;

    if (!this.lastDirectionalReadingDay) {
      this.lastDirectionalReadingDay = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingDay');
    }
    if (!this.lastDirectionalReadingMonth) {
      this.lastDirectionalReadingMonth = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingMonth');
    }
    if (!this.lastDirectionalReadingYear) {
      this.lastDirectionalReadingYear = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingYear');
    }

    let lastDay = { ...this.lastDirectionalReadingDay };
    let lastMonth = { ...this.lastDirectionalReadingMonth };
    let lastYear = { ...this.lastDirectionalReadingYear };

    let valDayImport = importValue - lastDay.importValue;
    let valDayExport = exportValue - lastDay.exportValue;
    let valMonthImport = importValue - lastMonth.importValue;
    let valMonthExport = exportValue - lastMonth.exportValue;
    let valYearImport = importValue - lastYear.importValue;
    let valYearExport = exportValue - lastYear.exportValue;

    if (periods.newDay) {
      await this.setCapability('meter_kwh_last_day.imported', valDayImport).catch((err) => this.error(err));
      await this.setCapability('meter_kwh_last_day.exported', valDayExport).catch((err) => this.error(err));
      lastDay = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingDay');
      valDayImport = 0; valDayExport = 0;
    }
    if (periods.newMonth) {
      await this.setCapability('meter_kwh_last_month.imported', valMonthImport).catch((err) => this.error(err));
      await this.setCapability('meter_kwh_last_month.exported', valMonthExport).catch((err) => this.error(err));
      lastMonth = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingMonth');
      valMonthImport = 0; valMonthExport = 0;
    }
    if (periods.newYear) {
      await this.setCapability('meter_kwh_last_year.imported', valYearImport).catch((err) => this.error(err));
      await this.setCapability('meter_kwh_last_year.exported', valYearExport).catch((err) => this.error(err));
      lastYear = { importValue, exportValue };
      this.markStoreDirty('lastDirectionalReadingYear');
      valYearImport = 0; valYearExport = 0;
    }

    await this.setCapability('meter_kwh_this_day.imported', valDayImport).catch((err) => this.error(err));
    await this.setCapability('meter_kwh_this_day.exported', valDayExport).catch((err) => this.error(err));
    await this.setCapability('meter_kwh_this_month.imported', valMonthImport).catch((err) => this.error(err));
    await this.setCapability('meter_kwh_this_month.exported', valMonthExport).catch((err) => this.error(err));
    await this.setCapability('meter_kwh_this_year.imported', valYearImport).catch((err) => this.error(err));
    await this.setCapability('meter_kwh_this_year.exported', valYearExport).catch((err) => this.error(err));

    if (periods.newDay) this.lastDirectionalReadingDay = lastDay;
    if (periods.newMonth) this.lastDirectionalReadingMonth = lastMonth;
    if (periods.newYear) this.lastDirectionalReadingYear = lastYear;
  }

  // Split money, always priced per direction whatever the scheme, as a bill itemizes it. Only
  // under 'perDirection' does net equal imported - exported. Not reset on a scheme switch.
  async updateSplitMoney(periods) {
    if (!this.splitMoney) {
      this.splitMoney = {
        day: { imported: 0, exported: 0 },
        month: { imported: 0, exported: 0 },
        year: { imported: 0, exported: 0 },
        lastDay: { imported: 0, exported: 0 },
        lastMonth: { imported: 0, exported: 0 },
        lastYear: { imported: 0, exported: 0 },
      };
    }
    const money = { ...this.splitMoney };
    if (!money.day) money.day = { imported: 0, exported: 0 };
    if (!money.lastDay) money.lastDay = { imported: 0, exported: 0 };

    let deltaImportMoney = 0;
    let deltaExportMoney = 0;
    const resolved = this._directionalTickDelta;
    if (resolved) {
      const {
        deltaImport, deltaExport, now, lastTm,
      } = resolved;
      const priceInterval = this.priceInterval || 60;
      const { tariff: effImportTariff, exportTariff: effExportTariff } = MeterHelpers.getPeriodTariff(
        this.tariffHistory,
        priceInterval,
        now,
        lastTm,
        undefined,
        this.timeZone,
      );
      deltaImportMoney = deltaImport * effImportTariff;
      deltaExportMoney = deltaExport * effExportTariff;
    }

    if (periods.newDay) {
      money.lastDay = { ...money.day };
      await this.setCapability('meter_money_last_day.imported', money.lastDay.imported).catch((err) => this.error(err));
      await this.setCapability('meter_money_last_day.exported', money.lastDay.exported).catch((err) => this.error(err));
      money.day = { imported: 0, exported: 0 };
    }
    if (periods.newMonth) {
      money.lastMonth = { ...money.month };
      await this.setCapability('meter_money_last_month.imported', money.lastMonth.imported).catch((err) => this.error(err));
      await this.setCapability('meter_money_last_month.exported', money.lastMonth.exported).catch((err) => this.error(err));
      money.month = { imported: 0, exported: 0 };
    }
    if (periods.newYear) {
      money.lastYear = { ...money.year };
      await this.setCapability('meter_money_last_year.imported', money.lastYear.imported).catch((err) => this.error(err));
      await this.setCapability('meter_money_last_year.exported', money.lastYear.exported).catch((err) => this.error(err));
      money.year = { imported: 0, exported: 0 };
    }

    // Fixed markups as in generic_sum_device.js#updateMoney(), on the import side only.
    let markup = 0;
    if (periods.newHour) markup += (this.getSettings().markup_hour || 0);
    if (periods.newDay) markup += (this.getSettings().markup_day || 0);
    if (periods.newMonth) markup += (this.getSettings().markup_month || 0);

    money.day.imported += deltaImportMoney;
    money.day.exported += deltaExportMoney;
    money.month.imported += deltaImportMoney;
    money.month.exported += deltaExportMoney;
    money.year.imported += deltaImportMoney;
    money.year.exported += deltaExportMoney;
    money.day.imported += markup;
    money.month.imported += markup;
    money.year.imported += markup;

    await this.setCapability('meter_money_this_day.imported', money.day.imported).catch((err) => this.error(err));
    await this.setCapability('meter_money_this_day.exported', money.day.exported).catch((err) => this.error(err));
    await this.setCapability('meter_money_this_month.imported', money.month.imported).catch((err) => this.error(err));
    await this.setCapability('meter_money_this_month.exported', money.month.exported).catch((err) => this.error(err));
    await this.setCapability('meter_money_this_year.imported', money.year.imported).catch((err) => this.error(err));
    await this.setCapability('meter_money_this_year.exported', money.year.exported).catch((err) => this.error(err));

    this.splitMoney = money;
    this.markStoreDirty('splitMoney');
  }

  // Capacity-tariff peak: the highest 15-minute AVERAGE import (e.g. Fluvius), not an
  // instantaneous max. Own anchor, as it must work without export data.
  async updatePeakLoad(reading) {
    const { importValue, exportValue } = this.directionalMeter;

    if (!this.lastPeakLoadReading) {
      this.lastPeakLoadReading = { importValue, exportValue };
      this.markStoreDirty('lastPeakLoadReading');
      return;
    }

    const deltaImportKwh = Math.max(0, importValue - this.lastPeakLoadReading.importValue);
    const hasExport = typeof exportValue === 'number' && typeof this.lastPeakLoadReading.exportValue === 'number';
    const deltaExportKwh = hasExport ? Math.max(0, exportValue - this.lastPeakLoadReading.exportValue) : 0;
    this.lastPeakLoadReading = { importValue, exportValue };
    this.markStoreDirty('lastPeakLoadReading');

    if (!this.peakLoad) {
      this.peakLoad = {
        slotStart: null,
        importKwhInSlot: 0,
        exportKwhInSlot: 0,
        day: { max: null, day: null, month: null },
        month: { max: null, month: null, year: null },
        year: { max: null, year: null },
        exportDay: { max: null, day: null, month: null },
        exportMonth: { max: null, month: null, year: null },
        exportYear: { max: null, year: null },
      };
    }

    const intervalMinutes = this.getPeakLoadIntervalMinutes();
    const slotStart = MeterHelpers.startOfBlock(reading.meterTm, intervalMinutes, this.timeZone);
    if (this.peakLoad.slotStart === null) {
      this.peakLoad.slotStart = slotStart;
    } else if (slotStart !== this.peakLoad.slotStart) {
      const slotHours = intervalMinutes / 60;
      const importAvgW = Math.round((this.peakLoad.importKwhInSlot / slotHours) * 1000);
      await this.checkPeakMax('measure_watt_peak', this.peakLoad.day, this.peakLoad.month, this.peakLoad.year, importAvgW, reading);
      await this.recordPeakWindow(this.peakLoad.slotStart, importAvgW);
      // Called for every closed slot of a device with export data, even at 0 W: checkPeakMax() holds
      // the period rollover. Case 2 never gets here.
      if (hasExport) {
        const exportAvgW = Math.round((this.peakLoad.exportKwhInSlot / slotHours) * 1000);
        await this.checkPeakMax(
          'measure_watt_peak_export',
          this.peakLoad.exportDay,
          this.peakLoad.exportMonth,
          this.peakLoad.exportYear,
          exportAvgW,
          reading,
        );
      }
      this.peakLoad.importKwhInSlot = 0;
      this.peakLoad.exportKwhInSlot = 0;
      this.peakLoad.slotStart = slotStart;
    }

    this.peakLoad.importKwhInSlot += deltaImportKwh;
    if (hasExport) this.peakLoad.exportKwhInSlot += deltaExportKwh;

    this.markStoreDirty('peakLoad');
  }

  // Month import peak so far, or null. Right after a month boundary it can still be last month's.
  getMonthPeakW(reading) {
    const month = this.peakLoad && this.peakLoad.month;
    if (!month || typeof month.max !== 'number') return null;
    if (reading && (month.month !== reading.month || month.year !== reading.year)) return null;
    return month.max;
  }

  // The running window was summed for the old length: drop it, or its average is off up to 4x.
  resetPeakWindow() {
    if (!this.peakLoad) return;
    this.peakLoad.slotStart = null;
    this.peakLoad.importKwhInSlot = 0;
    this.peakLoad.exportKwhInSlot = 0;
    this.markStoreDirty('peakLoad');
  }

  // Preset chosen: write its settings. A tariff setting changed by hand: the preset is 'custom'.
  // After the restart that follows onSettings(): Homey refuses setSettings while it is pending.
  async applyPeakSettingsChange() {
    const pending = this.peakSettingsPending;
    this.peakSettingsPending = null;
    if (!pending) return;
    const before = this.getSettings().peakLoadIntervalMinutes;
    if (pending.custom) await this.setSettings({ peakPreset: 'custom' });
    else if (PeakTariff.PRESETS[pending.preset]) await this.setSettings(PeakTariff.PRESETS[pending.preset]);
    this.peakConfig = PeakTariff.configFromSettings(this.getSettings());
    if (this.getSettings().peakLoadIntervalMinutes !== before) {
      this.resetPeakWindow();
      await this.updatePeakLoadCapabilityTitles();
    }
    this.log(`Capacity tariff: ${JSON.stringify({ ...this.peakConfig, months: this.peakConfig.months && [...this.peakConfig.months] })}`);
  }

  // First start with this version: start from this month's peak, when windows are unweighted.
  // History that no longer fits the settings starts empty (the month peak may be another window).
  async seedPeakHistory() {
    const cfg = this.peakConfig;
    const local = TimeHelpers.toLocalDate(new Date(), this.timeZone);
    const monthKey = PeakTariff.monthKeyOf(local);
    const h = this.peakHistory;
    if (!h || h.month !== monthKey || h.sig !== PeakTariff.signature(cfg)) {
      const { month, day } = this.peakLoad || {};
      // The month peak is of the current window length (the first part of the signature).
      const sameWindow = !h || String(h.sig).split('|')[0] === String(cfg.windowMin);
      const seedable = sameWindow && month && typeof month.max === 'number' && !PeakTariff.hasWeighting(cfg)
        && `${month.year}-${String(month.month + 1).padStart(2, '0')}` === monthKey;
      // Today's own key when the month peak is today's, so the day is not counted twice.
      const today = seedable && day && day.max === month.max && day.day === local.getDate() && day.month === local.getMonth();
      this.peakHistory = seedable
        ? PeakTariff.recordWindow(null, cfg, { monthKey, dayKey: today ? PeakTariff.dayKeyOf(local) : 'seed', weightedW: month.max })
        : null;
      this.markStoreDirty('peakHistory');
    }
    await this.setCapability('measure_watt_peak.billed', PeakTariff.billedW(this.peakHistory, cfg, monthKey)).catch(this.error);
  }

  async recordPeakWindow(startMs, avgW) {
    const cfg = this.peakConfig;
    const local = TimeHelpers.toLocalDate(new Date(startMs), this.timeZone || this.homey.clock.getTimezone());
    const monthKey = PeakTariff.monthKeyOf(local);
    this.peakHistory = PeakTariff.recordWindow(this.peakHistory, cfg, {
      monthKey,
      dayKey: PeakTariff.dayKeyOf(local),
      weightedW: avgW * PeakTariff.weightAt(cfg, local),
    });
    this.markStoreDirty('peakHistory');
    await this.setCapability('measure_watt_peak.billed', PeakTariff.billedW(this.peakHistory, cfg, monthKey)).catch(this.error);
  }

  // Capacity tariff for the window holding atMs. limitW: the window average (W, unweighted) above
  // which this month's bill rises; Infinity: free (weight 0, above the last step); null: no level
  // yet. See PeakTariff.threshold().
  getPeakState(atMs = Date.now()) {
    const cfg = this.peakConfig;
    const fillW = cfg.selection === 'max' ? 0 : this.getExpectedDailyPeakW();
    // Called per meter reading for the same window: reused while nothing it depends on changed.
    const m = this.peakStateMemo;
    if (m && m.atMs === atMs && m.history === this.peakHistory && m.cfg === cfg && m.fillW === fillW) return m.state;
    const local = TimeHelpers.toLocalDate(new Date(atMs), this.timeZone || this.homey.clock.getTimezone());
    const t = PeakTariff.threshold(this.peakHistory, cfg, {
      monthKey: PeakTariff.monthKeyOf(local), dayKey: PeakTariff.dayKeyOf(local), fillW,
    });
    const weight = PeakTariff.weightAt(cfg, local);
    let limitW = null;
    if (t.thresholdW === Infinity || (t.thresholdW !== null && weight <= 0)) limitW = Infinity;
    else if (t.thresholdW !== null) limitW = Math.round(t.thresholdW / weight);
    const state = { ...t, weight, limitW };
    this.peakStateMemo = {
      atMs, history: this.peakHistory, cfg, fillW, state,
    };
    return state;
  }

  // The main fuse less the margin (W), for import and export. null: unknown.
  getFuseLimitW() {
    const limitW = this.getConnectionLimitW();
    return limitW > 0 ? FuseGuard.withMargin(limitW, this.getSettings().fuseMarginPct) : null;
  }

  // The main fuse of one phase less the margin (W).
  getPhaseFuseLimitW() {
    const s = this.getSettings();
    return FuseGuard.withMargin(GridConnection.phaseLimitFromSettings(s) || GridConnection.DEFAULT_LIMIT_W / 3, s.fuseMarginPct);
  }

  // Power per phase now (W, + import). null: a 1-phase connection, or no recent phase readings.
  getPhasePowerW(now = Date.now()) {
    if (Number(this.getSettings().connectionPhases) === 1 || !this.phaseW || !this.phaseSeen.every(Boolean)) return null;
    if (this.phaseW.some((w) => typeof w !== 'number') || this.isGridPowerStale(now)) return null;
    return this.phaseW;
  }

  // The connection setting against what the meter shows: notified once per mismatch (store
  // phaseSetupNotified), cleared when they match.
  checkPhaseSetup(now) {
    if (!this.phaseW || !this.phaseSeen) return;
    const one = Number(this.getSettings().connectionPhases) === 1;
    const three = this.phaseSeen.every(Boolean);
    const onlyL1 = this.phaseSeen[0] && !this.phaseSeen[1] && !this.phaseSeen[2] && now - this.phaseListenTm >= PHASE_CHECK_MS;
    let kind = null;
    if (one && three) kind = 'phase_setup_three';
    else if (!one && onlyL1) kind = 'phase_setup_one';
    else if (!(one ? onlyL1 : three)) return; // not clear yet
    if (this.phaseSetupKind === undefined) this.phaseSetupKind = this.getStoreValue('phaseSetupNotified') || null;
    if (kind === this.phaseSetupKind) return;
    this.phaseSetupKind = kind;
    this.setStoreValue('phaseSetupNotified', kind).catch(this.error);
    if (!kind) return;
    this.log(`[Fuse] ${kind}`);
    this.homey.notifications.createNotification({ excerpt: this.homey.__(kind, { name: this.getName() }) }).catch(this.error);
  }

  // Learned phases count, unless a phase overload lasted (checkFuseOverload()).
  trustsLearnedPhases(now = Date.now()) {
    return !(now < (this.phaseDistrustUntil || 0));
  }

  // The phase readings of the last PHASE_HISTORY_MS, for PhaseLearning.
  recordPhasePower(now) {
    const phaseW = this.getPhasePowerW(now);
    if (!phaseW) return;
    if (!this.phaseHistory) this.phaseHistory = [];
    this.phaseHistory.push({ tm: now, w: [...phaseW] });
    while (this.phaseHistory.length && now - this.phaseHistory[0].tm > PHASE_HISTORY_MS) this.phaseHistory.shift();
  }

  // Mean power per phase (W) of the readings from fromMs to toMs. null: none.
  getPhaseMeanW(fromMs, toMs) {
    const list = (this.phaseHistory || []).filter((e) => e.tm >= fromMs && e.tm <= toMs);
    if (!list.length) return null;
    return [0, 1, 2].map((i) => list.reduce((a, e) => a + e.w[i], 0) / list.length);
  }

  // Extra import (W) possible now under the phase fuses for a device on spec (FuseGuard.phaseRoomW).
  // withYield: the grid charging of the protected batteries on known phases counts (they give way).
  // null: no phase readings.
  getPhaseRoomW(spec, now = Date.now(), { withYield = false } = {}) {
    let phaseW = this.getPhasePowerW(now);
    if (!phaseW) return null;
    if (withYield) {
      const y = this.getPhaseYieldW(now);
      phaseW = phaseW.map((w, i) => w - y[i]);
    }
    return Math.round(FuseGuard.phaseRoomW({
      phaseW, limitW: this.getPhaseFuseLimitW(), spec, reservedW: this.reservedPhaseW(now),
    }));
  }

  // Extra export (W) possible now under the phase fuses for a device on spec. null: no phase readings.
  getPhaseExportRoomW(spec, now = Date.now()) {
    const phaseW = this.getPhasePowerW(now);
    if (!phaseW) return null;
    return Math.round(FuseGuard.phaseRoomW({ phaseW: phaseW.map((w) => -w), limitW: this.getPhaseFuseLimitW(), spec }));
  }

  // getYieldingBatteryW() per phase (W), of the batteries with a known phase.
  getPhaseYieldW(now = Date.now()) {
    const y = [0, 0, 0];
    const trust = this.trustsLearnedPhases(now);
    this.yieldingBatteries(now).forEach(({ d, w }) => {
      const spec = typeof d.fusePhases === 'function' ? d.fusePhases(trust) : null;
      if (spec && spec.known) {
        FuseGuard.perPhaseW(w, spec).forEach((x, i) => {
          y[i] += x;
        });
      }
    });
    return y;
  }

  // Instant import limit (W): the contracted power when set, else the main fuse. null: unknown.
  getHardLimitW() {
    const contracted = this.peakConfig.hardLimitW;
    const fuse = this.getFuseLimitW();
    if (contracted > 0) return fuse ? Math.min(contracted, fuse) : contracted;
    return fuse;
  }

  // Extra export (W) possible now under the main fuse. null: no limit.
  getExportHeadroomW() {
    const fuse = this.getFuseLimitW();
    if (!fuse) return null;
    return Math.round(fuse - FuseGuard.CONTROL_RESERVE_W - Math.max(0, -(this.getCapabilityValue('measure_watt_grid') || 0)));
  }

  // Extra import (W) the EV chargers are about to take (reserveImport()): less what each already
  // takes more than when reserved, 0 when expired. [{ charger, w }].
  importReservations(now = Date.now()) {
    if (!this.importReserves) return [];
    const out = [];
    this.importReserves.forEach((r, charger) => {
      if (now >= r.untilMs) {
        this.importReserves.delete(charger);
        return;
      }
      out.push({ charger, w: Math.max(0, r.w - Math.max(0, FuseGuard.chargerPowerW(charger) - r.baseW)) });
    });
    return out;
  }

  reservedImportW(now = Date.now()) {
    return this.importReservations(now).reduce((a, r) => a + r.w, 0);
  }

  // reservedImportW() per phase (W): on the phases of each charger.
  reservedPhaseW(now = Date.now()) {
    const out = [0, 0, 0];
    const trust = this.trustsLearnedPhases(now);
    const limitW = this.getPhaseFuseLimitW();
    this.importReservations(now).forEach(({ charger, w }) => {
      const spec = typeof charger.fusePhases === 'function' ? charger.fusePhases(trust) : {};
      FuseGuard.perPhaseW(w, spec, limitW).forEach((x, i) => {
        out[i] += x;
      });
    });
    return out;
  }

  // An EV charger released or raised: the batteries make room for w before the car takes it.
  reserveImport(charger, w, now = Date.now()) {
    if (!(w > 0)) return;
    if (!this.importReserves) this.importReserves = new Map();
    const prev = this.importReserves.get(charger);
    const keep = prev && now < prev.untilMs;
    this.importReserves.set(charger, {
      w: (keep ? prev.w : 0) + w,
      baseW: keep ? prev.baseW : FuseGuard.chargerPowerW(charger),
      untilMs: now + FuseGuard.RESERVE_MS,
    });
  }

  // Grid charging of the protected batteries: they give way to an EV charger under the limit.
  // [{ d, w }].
  yieldingBatteries(now = Date.now()) {
    let bats = [];
    try {
      bats = this.homey.drivers.getDriver('battery').getDevices();
    } catch {
      return [];
    }
    return bats.map((d) => {
      try {
        return { d, w: typeof d.fuseYieldW === 'function' ? d.fuseYieldW(now) : 0 };
      } catch {
        return { d, w: 0 };
      }
    });
  }

  getYieldingBatteryW() {
    return this.yieldingBatteries().reduce((a, b) => a + b.w, 0);
  }

  // No recent reading from a realtime power source (FuseGuard.isStale()). A trend-only source
  // (2-minute average) is never stale here: it cannot protect the fuse in time anyway.
  isGridPowerStale(now = Date.now()) {
    const ci = this.capabilityInstances || {};
    if (!ci.measurePowerRealtime && !ci.measurePower) return false;
    if (!this.gridPowerTm && !this.gridStaleRefTm) this.gridStaleRefTm = now; // no reading since start: from the first check
    return FuseGuard.isStale({ tm: this.gridPowerTm || this.gridStaleRefTm, now, intervalMs: this.gridIntervalMs });
  }

  // Import above the hard limit, or on a phase above its fuse, for FuseGuard.SHED_AFTER_MS: cut or
  // switch off one charging EV charger. Export above the fuse that long: notified only (the
  // batteries are all there is).
  checkFuseOverload(now) {
    const gridW = this.getCapabilityValue('measure_watt_grid') || 0;
    const importW = Math.max(0, gridW);
    const limitW = this.getHardLimitW();
    const phaseW = this.getPhasePowerW(now);
    const phaseLimitW = phaseW ? this.getPhaseFuseLimitW() : null;
    const overW = limitW > 0 ? importW - limitW : -Infinity;
    const phaseOverW = phaseW ? phaseW.map((w) => w - phaseLimitW) : null;
    const over = this.fuseOverWhere({
      overW, phaseOverW, totalW: importW, limitW, phaseW, phaseLimitW,
    });
    const step = FuseGuard.overloadStep({ overW: over.w, now, overSince: this.fuseOverSince });
    if (step.overSince && !this.fuseOverSince) this.log(`[Fuse] ${over.label}`);
    this.fuseOverSince = step.overSince;
    if (over.phase && step.overSince && now - step.overSince >= FuseGuard.DISTRUST_AFTER_MS && this.trustsLearnedPhases(now)) {
      this.phaseDistrustUntil = now + FuseGuard.DISTRUST_HOLD_MS;
      this.log(`[Fuse] ${over.label} for ${Math.round((now - step.overSince) / 1000)} s: learned phases not trusted for an hour`);
    }

    const exportW = Math.max(0, -gridW);
    const exportLimitW = this.getFuseLimitW();
    const exp = this.fuseOverWhere({
      overW: exportLimitW > 0 ? exportW - exportLimitW : -Infinity,
      phaseOverW: phaseW ? phaseW.map((w) => -w - phaseLimitW) : null,
      totalW: exportW,
      limitW: exportLimitW,
      phaseW: phaseW && phaseW.map((w) => -w),
      phaseLimitW,
      kind: 'export',
    });
    const expStep = FuseGuard.overloadStep({ overW: exp.w, now, overSince: this.fuseExportSince });
    if (expStep.shed && this.fuseExportNotified !== expStep.overSince) {
      this.fuseExportNotified = expStep.overSince;
      this.log(`[Fuse] ${exp.label} for 30 s`);
      this.notifyFuse(exp.phase ? 'fuse_phase_export' : 'fuse_export', exp.tokens, now);
    }
    this.fuseExportSince = expStep.overSince;

    if (!step.shed) return;
    let chargers = [];
    try {
      chargers = this.homey.drivers.getDriver('evCharger').getDevices().filter((d) => typeof d.fuseShed === 'function');
    } catch {
      // no EV chargers
    }
    const overload = {
      importW, limitW, overW, phaseOverW, label: over.label, distrust: !this.trustsLearnedPhases(now),
    };
    let done = null;
    // Measured charging first, then switched on without a charging reading.
    [false, true].some((uncertain) => chargers.some((d) => {
      try {
        done = d.fuseShed(now, overload, uncertain);
      } catch (err) {
        this.error('[Fuse]', err);
        done = null;
      }
      return !!done;
    }));
    const prefix = over.phase ? 'fuse_phase_import' : 'fuse_import';
    if (done) {
      this.fuseOverSince = now;
      if (done.off) this.notifyFuse(`${prefix}_ev_off`, { ...over.tokens, charger: done.name }, now);
      else this.notifyFuse(`${prefix}_ev_limited`, { ...over.tokens, charger: done.name, power: done.capW }, now);
    } else if (this.fuseNothingToShed !== this.fuseOverSince) {
      this.fuseNothingToShed = this.fuseOverSince;
      this.log(`[Fuse] ${over.label} for ${Math.round((now - this.fuseOverSince) / 1000)} s: no EV charger to cut`);
      this.notifyFuse(prefix, over.tokens, now);
    }
  }

  // The largest overload: the total (overW) or a phase (phaseOverW), with its log label and
  // notification tokens. w > 0: over.
  fuseOverWhere({
    overW, phaseOverW, totalW, limitW, phaseW, phaseLimitW, kind = 'import',
  }) {
    const i = phaseOverW ? phaseOverW.indexOf(Math.max(...phaseOverW)) : -1;
    if (i < 0 || overW > 0 || !(phaseOverW[i] > overW)) {
      return {
        w: overW,
        label: `${kind} ${Math.round(totalW)} W above ${limitW} W`,
        tokens: { [kind]: Math.round(totalW), limit: limitW },
      };
    }
    const phase = `L${i + 1}`;
    return {
      w: phaseOverW[i],
      phase,
      label: `${kind} ${phase} ${Math.round(phaseW[i])} W above ${phaseLimitW} W`,
      tokens: { phase, [kind]: Math.round(phaseW[i]), limit: phaseLimitW },
    };
  }

  // Timeline notification of a fuse protection, per kind at most once per FuseGuard.NOTIFY_MS.
  notifyFuse(key, tokens, now) {
    if (!this.fuseNotifyTm) this.fuseNotifyTm = {};
    if (this.fuseNotifyTm[key] && now - this.fuseNotifyTm[key] < FuseGuard.NOTIFY_MS) return;
    this.fuseNotifyTm[key] = now;
    const t = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, String(v)]));
    this.homey.notifications.createNotification({ excerpt: this.homey.__(key, t) }).catch(this.error);
  }

  // Extra import (W) possible now for a battery controller: the capacity-tariff headroom of the
  // running window (tariff, only with a tariff to shave for) and the hard limit (hard: contract or
  // main fuse). null: no limit.
  getImportHeadroomW({ tariff = true, hard = true } = {}) {
    const importW = Math.max(0, this.getCapabilityValue('measure_watt_grid') || 0);
    const limits = [];
    const p = this.peakProjection;
    if (tariff && PeakTariff.isActive(this.peakConfig) && p && typeof p.tariffHeadroomW === 'number') limits.push(p.tariffHeadroomW);
    const hardW = hard ? this.getHardLimitW() : 0;
    if (hardW > 0) limits.push(hardW - FuseGuard.CONTROL_RESERVE_W - this.reservedImportW() - importW);
    return limits.length ? Math.round(Math.min(...limits)) : null;
  }

  // Median over the rest of this month of the expected daily maximum (weighted window average,
  // grid forecast without battery). Fills the top N early in the month. Cached for an hour.
  getExpectedDailyPeakW() {
    const nowMs = Date.now();
    if (this.expectedDailyPeak && nowMs - this.expectedDailyPeak.tm < 60 * 60 * 1000) return this.expectedDailyPeak.w;
    let w = 0;
    try {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const startMs = MeterHelpers.startOfBlock(nowMs, this.peakConfig.windowMin, tz);
      const net = this.getNetForecast(startMs, this.startOfNextMonthMs(nowMs, tz)).netNoBattery;
      const dayMax = {};
      this.eachForecastWindow(net, startMs, tz, ({ avgW, weight, local }) => {
        if (weight <= 0) return;
        const day = PeakTariff.dayKeyOf(local);
        dayMax[day] = Math.max(dayMax[day] || 0, avgW * weight);
      });
      const days = Object.values(dayMax).sort((a, b) => a - b);
      if (days.length) w = Math.round(days[Math.floor(days.length / 2)]);
    } catch (err) {
      this.error(err);
    }
    this.expectedDailyPeak = { tm: nowMs, w };
    return w;
  }

  // Local midnight at the start of next month (ms).
  startOfNextMonthMs(nowMs, tz) {
    const nowLocal = TimeHelpers.toLocalDate(new Date(nowMs), tz);
    return TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(nowLocal.getFullYear(), nowLocal.getMonth() + 1, 1, 12)), tz).getTime();
  }

  // Per capacity-tariff window of a 15-min net forecast from startMs (a window start):
  // fn({ t, avgW (import), weight, local }).
  eachForecastWindow(net, startMs, tz, fn) {
    const cfg = this.peakConfig;
    const perWindow = cfg.windowMin / 15;
    for (let i = 0; i + perWindow <= net.length; i += perWindow) {
      const t = startMs + (i * 15 * 60 * 1000);
      const local = TimeHelpers.toLocalDate(new Date(t), tz);
      const avgW = net.slice(i, i + perWindow).reduce((a, v) => a + Math.max(0, v), 0) / perWindow;
      fn({
        t, avgW, weight: PeakTariff.weightAt(cfg, local), local,
      });
    }
  }

  // Average import (W) still allowed over the rest of the running window to keep it at limitW.
  windowAllowanceW(limitW, nowMs) {
    const slotMs = this.getPeakLoadIntervalMinutes() * 60 * 1000;
    const remainingH = Math.max(1 / 60, (this.peakLoad.slotStart + slotMs - nowMs) / 3600000);
    return (((limitW * slotMs) / 3600000) - (this.peakLoad.importKwhInSlot * 1000)) / remainingH;
  }

  /**
   * Import limits per 15-minute slot, for a battery or EV planner.
   *
   * @returns {{active: boolean, windowMin: number, hardLimitW: number, exportLimitW: number|null, slots: Array<{limitW: number|null,
   *   penaltyPerKw: number|null, stepJump: number|null}>}} active: a capacity tariff to shave for;
   *   limitW applies to the average over the slot's window (see getPeakState()).
   */
  getPeakLimitSeries(startMs, endMs) {
    const cfg = this.peakConfig;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const nowMs = Date.now();
    const running = this.peakLoad ? this.peakLoad.slotStart : null;
    const slots = [];
    let windowStart = null;
    let state = null;
    let limitW = null;
    for (let t = startMs; t < endMs; t += 15 * 60 * 1000) {
      const ws = MeterHelpers.startOfBlock(t, cfg.windowMin, tz);
      if (ws !== windowStart) {
        windowStart = ws;
        state = this.getPeakState(ws);
        // The running window: what its import so far leaves for the rest of it.
        limitW = ws === running && Number.isFinite(state.limitW)
          ? Math.max(0, Math.round(this.windowAllowanceW(state.limitW, nowMs))) : state.limitW;
      }
      slots.push({ limitW, penaltyPerKw: state.penaltyPerKw, stepJump: state.stepJump });
    }
    return {
      active: PeakTariff.isActive(cfg), windowMin: cfg.windowMin, hardLimitW: this.getHardLimitW(), exportLimitW: this.getFuseLimitW(), slots,
    };
  }

  // Projection for the running peak slot, assuming the current import holds:
  //   projected = (energy so far + current import x remaining time) / slot length
  //   headroom  = extra power possible now without the slot average exceeding the billed peak
  // Fires peak_projected_exceeded once per slot.
  async updatePeakProjection(reading) {
    if (!this.peakLoad || this.peakLoad.slotStart === null) return;
    const slotMs = this.getPeakLoadIntervalMinutes() * 60 * 1000;
    const slotH = slotMs / 3600000;
    const nowMs = new Date(reading.meterTm).getTime();
    const remainingH = Math.max(0, (this.peakLoad.slotStart + slotMs - nowMs) / 3600000);
    const energyWh = this.peakLoad.importKwhInSlot * 1000;
    const importW = Math.max(0, this.getCapabilityValue('measure_watt_grid') || 0);
    const projectedW = Math.round((energyWh + (importW * remainingH)) / slotH);
    const { limitW } = this.getPeakState(this.peakLoad.slotStart);
    const monthPeakW = limitW === Infinity ? null : limitW;
    let headroomW = null;
    if (monthPeakW !== null) headroomW = Math.round(this.windowAllowanceW(monthPeakW, nowMs) - importW);
    const tariffHeadroomW = headroomW;
    if (this.peakConfig.hardLimitW > 0) {
      const hardHeadroomW = Math.round(this.getHardLimitW() - importW);
      headroomW = headroomW === null ? hardHeadroomW : Math.min(headroomW, hardHeadroomW);
    }
    const newSlot = !this.peakProjection || this.peakProjection.slotStart !== this.peakLoad.slotStart;
    this.peakProjection = {
      slotStart: this.peakLoad.slotStart, projectedW, monthPeakW, headroomW, tariffHeadroomW,
    };
    // At most one write per 10 s (fast P1 meters).
    if (newSlot || !this.peakProjectionWriteTm || Math.abs(nowMs - this.peakProjectionWriteTm) >= 10000) {
      this.peakProjectionWriteTm = nowMs;
      await this.setCapability('measure_watt_peak.projected', projectedW).catch(this.error);
      await this.setCapability('measure_watt_peak.headroom', headroomW).catch(this.error);
    }

    if (monthPeakW !== null && projectedW > monthPeakW && this.peakExceededSlot !== this.peakLoad.slotStart) {
      this.peakExceededSlot = this.peakLoad.slotStart;
      await this.setStoreValue('peakExceededSlot', this.peakExceededSlot).catch(this.error);
      await this.flows.triggerPeakProjectedExceeded(projectedW, monthPeakW).catch(this.error);
    }
  }

  // Expected peak-slot import from the net forecast that counts most for the capacity tariff
  // (highest weighted average), up to the end of tomorrow or of this month, whichever comes first.
  getExpectedPeak() {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const { windowMin } = this.peakConfig;
    const nowMs = Date.now();
    const startMs = MeterHelpers.startOfBlock(nowMs, windowMin, tz) + (windowMin * 60 * 1000);
    const tomorrowEnd = TimeHelpers.getUTCPeriods(tz).tomorrowEnd.getTime();
    const endMs = Math.min(tomorrowEnd, this.startOfNextMonthMs(nowMs, tz));
    let best = null;
    if (endMs > startMs) {
      this.eachForecastWindow(this.getNetForecast(startMs, endMs).netPlanned, startMs, tz, ({ t, avgW, weight }) => {
        const weighted = avgW * weight;
        if (!best || weighted > best.weighted) best = { w: Math.round(avgW), weighted, t };
      });
    }
    return best
      ? { expectedPeakW: best.w, expectedPeakTime: new Date(best.t).toISOString(), expectedPeakTm: best.t }
      : { expectedPeakW: null, expectedPeakTime: null, expectedPeakTm: null };
  }

  // monthPeakW: the level the current window is held against (getPeakState().limitW).
  getPeakForecast() {
    const p = this.peakProjection || {};
    const now = this.getPeakState();
    let { monthPeakW } = p;
    if (monthPeakW === undefined) monthPeakW = now.limitW === Infinity ? null : now.limitW;
    const { expectedPeakW, expectedPeakTime, expectedPeakTm } = this.getExpectedPeak();
    const atPeak = expectedPeakTm !== null ? this.getPeakState(expectedPeakTm) : null;
    return {
      monthPeakW,
      // As measure_watt_peak.billed: measured values only (now.billedW includes the fill).
      billedW: PeakTariff.billedW(this.peakHistory, this.peakConfig,
        PeakTariff.monthKeyOf(TimeHelpers.toLocalDate(new Date(), this.timeZone || this.homey.clock.getTimezone()))),
      projectedSlotW: p.projectedW !== undefined ? p.projectedW : null,
      headroomW: p.headroomW !== undefined ? p.headroomW : null,
      expectedPeakW,
      expectedPeakTime,
      newPeakExpected: !!atPeak && atPeak.limitW !== null && expectedPeakW > atPeak.limitW,
    };
  }

  // Rolls over each crossed period, then updates its max with a closed slot's average.
  async checkPeakMax(prefix, day, month, year, avgW, reading) {
    let changed = false;
    if (day.day !== null && (day.day !== reading.day || day.month !== reading.month)) {
      day.max = null; changed = true;
    }
    if (month.month !== null && (month.month !== reading.month || month.year !== reading.year)) {
      month.max = null; changed = true;
    }
    if (year.year !== null && year.year !== reading.year) {
      year.max = null; changed = true;
    }
    day.day = reading.day; day.month = reading.month;
    month.month = reading.month; month.year = reading.year;
    year.year = reading.year;

    if (day.max === null || avgW > day.max) {
      day.max = avgW; changed = true;
    }
    if (month.max === null || avgW > month.max) {
      month.max = avgW; changed = true;
    }
    if (year.max === null || avgW > year.max) {
      year.max = avgW; changed = true;
    }

    if (changed) {
      await this.setCapability(`${prefix}.day`, day.max).catch((err) => this.error(err));
      await this.setCapability(`${prefix}.month`, month.max).catch((err) => this.error(err));
      await this.setCapability(`${prefix}.year`, year.max).catch((err) => this.error(err));
    }
  }

  // 'fixedBlock': net within a fixed time block, priced at the tariff of the block's start once
  // it closes. Returns 0 until then. The open block is stored (directionalBlockState).
  async computeFixedBlockDeltaMoney(deltaImport, deltaExport, now) {
    const blockMinutes = this.getDirectionalBlockMinutes();
    const currentBlockStart = MeterHelpers.startOfBlock(now, blockMinutes, this.timeZone);
    const freshBlock = () => ({
      blockStartTm: currentBlockStart,
      importAccum: 0,
      exportAccum: 0,
      blockTariff: {
        tariff: this.tariffHistory.current,
        exportTariff: typeof this.tariffHistory.currentExport === 'number' ? this.tariffHistory.currentExport : this.tariffHistory.current,
      },
    });
    if (!this.directionalBlockState) this.directionalBlockState = freshBlock();

    let deltaMoney = 0;
    if (currentBlockStart > this.directionalBlockState.blockStartTm) {
      const net = this.directionalBlockState.importAccum - this.directionalBlockState.exportAccum;
      const netImport = net > 0 ? net : 0;
      const netExport = net < 0 ? -net : 0;
      const { tariff: closingTariff, exportTariff: closingExportTariff } = this.directionalBlockState.blockTariff;
      deltaMoney = (netImport * closingTariff) - (netExport * closingExportTariff);
      this.directionalBlockState = freshBlock();
    }
    this.directionalBlockState.importAccum += Math.max(0, deltaImport);
    this.directionalBlockState.exportAccum += Math.max(0, deltaExport);
    this.markStoreDirty('directionalBlockState');
    return deltaMoney;
  }

  // --- Load Forecast Logic ---

  async startForecastLoop() {
    // Idempotent: clears the pending timer, and the epoch makes an invocation already running
    // (retrainLoadModel() can take long) stand down instead of rescheduling itself.
    if (this.forecastTimeout) this.homey.clearTimeout(this.forecastTimeout);
    this.forecastEpoch = (this.forecastEpoch || 0) + 1;
    const epoch = this.forecastEpoch;
    let firstRun = true;
    const loop = async () => {
      if (this.isDestroyed || epoch !== this.forecastEpoch) return;
      try {
        // Not at startup: the startup retrain is in initLearningTimeout.
        if (!firstRun) {
          const now = new Date();
          const localNow = TimeHelpers.toLocalDate(now, this.timeZone);
          if (localNow.getHours() === 2) {
            const lastRun = new Date(this.lastAutoRetrainLoad);
            const isSameDay = lastRun.getDate() === localNow.getDate() && lastRun.getMonth() === localNow.getMonth() && lastRun.getFullYear() === localNow.getFullYear();

            if (!isSameDay) {
              this.log('Running automatic nightly load model retraining...');
              await this.retrainLoadModel(false);
              this.lastAutoRetrainLoad = now.getTime();
              await this.setStoreValue('lastAutoRetrainLoad', this.lastAutoRetrainLoad);
            }
          }
        }
      } catch (err) {
        this.error('Load forecast loop failed:', err);
      } finally {
        firstRun = false;
        if (!this.isDestroyed && epoch === this.forecastEpoch) {
          this.forecastTimeout = this.homey.setTimeout(() => {
            loop().catch(this.error);
          }, 60 * 60 * 1000);
        }
      }
    };
    await loop();
  }

  // Idempotent, as startForecastLoop().
  async startLearningLoop() {
    if (this.learningTimeout) this.homey.clearTimeout(this.learningTimeout);
    this.learningEpoch = (this.learningEpoch || 0) + 1;
    const epoch = this.learningEpoch;
    const loop = async () => {
      if (this.isDestroyed || epoch !== this.learningEpoch) return;
      try {
        if (!this.retrainingLoad) {
          const updated = await this.updateLearning();
          const now = new Date();
          const is15mBoundary = (now.getMinutes() % 15 === 0);
          if (updated || is15mBoundary || !this.chartNetToday) {
            await this.updateForecastDisplay(updated);
          }
        }
      } catch (err) {
        this.error('Load learning update failed:', err);
      } finally {
        if (!this.isDestroyed && epoch === this.learningEpoch) {
          const now = new Date();
          const nextSlot = new Date(now);
          nextSlot.setMinutes(now.getMinutes() + 1, 0, 0);
          let delay = nextSlot - now;
          if (delay < 1000) delay += 60 * 1000;
          this.learningTimeout = this.homey.setTimeout(() => {
            loop().catch(this.error);
          }, delay);
        }
      }
    };
    await loop();
  }

  async updateLearning() {
    let updated = false;
    const now = new Date();
    const currentTimestamp = now.getTime();

    const rawPower = this.getCapabilityValue('measure_watt_home');
    const currentEnergy = this.getCapabilityValue('meter_power_hidden.home');

    const { smoothedPower, newEnergyState } = LoadForecastStrategy.calculateSmoothedPower({
      currentPower: rawPower,
      currentEnergy,
      lastEnergyState: this.lastEnergyState,
      currentTimestamp,
    });
    this.lastEnergyState = newEnergyState;
    const currentPower = smoothedPower;

    if (typeof currentPower !== 'number' || Number.isNaN(currentPower) || currentPower < 0) {
      return updated;
    }

    const details = LoadForecastStrategy.getLocalTimeDetails(now, this.timeZone);
    const currentSlotIndex = details.slotIndex;

    const bucketResult = LoadForecastStrategy.processBucket({
      bucket: this.learningBucket,
      currentSlotIndex,
      currentTimestamp,
      currentPower,
      currentEnergy,
    });

    this.learningBucket = bucketResult.bucket;

    if (bucketResult.finishedBucket) {
      if (bucketResult.finishedBucket.log) this.log(bucketResult.finishedBucket.log);
      await this.recordForecastError(bucketResult.finishedBucket).catch(this.error);

      // A slot with a planned extra load is not learned.
      const { startTime, durationMs } = bucketResult.finishedBucket;
      if (LoadForecastStrategy.getPlannedPower(this.plannedLoads, startTime, startTime + durationMs) > 0) return updated;
      // Program appliances are forecast separately. A slot not measured in full is not learned;
      // an appliance that is not running (initReady false) is not measured: learned as home load,
      // else one broken source stops all learning.
      let appliancesW = 0;
      for (const dev of this.getApplianceDevices().filter((d) => d.initReady)) {
        const w = dev.getAvgPower(startTime, startTime + durationMs);
        if (w === null) return updated;
        appliancesW += w;
      }
      const result = LoadForecastStrategy.getStrategy({
        currentPower: Math.max(0, bucketResult.finishedBucket.avgPower - appliancesW),
        weeklyProfile: this.weeklyProfile,
        timestamp: new Date(bucketResult.finishedBucket.startTime),
        timezone: this.timeZone,
        alpha: 0.1,
      });

      if (result.updated) {
        this.weeklyProfile = result.weeklyProfile;
        await this.setStoreValue('weeklyProfile', this.weeklyProfile);
        this.log(result.log);
        updated = true;
      }
    }
    return updated;
  }

  // Before the slot's learning update, which would pull the prediction toward the actual.
  // Slots shorter than 10 minutes (after a restart) are not scored.
  async recordForecastError(finishedBucket) {
    if (!finishedBucket || finishedBucket.durationMs < 10 * 60 * 1000) return;
    const { dayOfWeek, slotIndex } = LoadForecastStrategy.getLocalTimeDetails(finishedBucket.startTime, this.timeZone);
    const learned = this.weeklyProfile && this.weeklyProfile[dayOfWeek] ? this.weeklyProfile[dayOfWeek][slotIndex] : null;
    if (!learned) return;
    const { startTime, durationMs } = finishedBucket;
    // The forecast as recorded when the slot started, else rebuilt.
    const slotStart = TimeHelpers.startOfLocalBlock(startTime, 15, this.timeZone);
    const recorded = this.netForecastHistory.find((e) => e.time === slotStart && typeof e.load === 'number');
    this.forecastErrors = LoadForecastStrategy.recordForecastError(this.forecastErrors, {
      time: startTime,
      predicted: recorded ? recorded.load
        : learned + LoadForecastStrategy.getPlannedPower(this.plannedLoads, startTime, startTime + durationMs),
      actual: finishedBucket.avgPower,
    });
    this.fileStore.set('forecastErrors', this.forecastErrors);
    const hourClosed = new Date(finishedBucket.startTime).getUTCMinutes() >= 45;
    if (hourClosed) await this.updateForecastAccuracyStatus();
  }

  // Forecast grid exchange (W, + import / - export) per 15-minute slot:
  //   netNoBattery = home load - solar forecast + planned EV charging
  //   netPlanned   = netNoBattery + planned battery power (+ charge / - discharge)
  // A battery planner must plan against netNoBattery, not its own plan. Solar from PbtH solar
  // devices only, battery from PbtH batteries with ROI on. EV only while the car is connected.
  getNetForecast(startMs, endMs) {
    const load = this.getHomeLoadSeries(startMs, endMs);
    const sumSeries = (driverId, getSeries) => this.sumDriverSeries(driverId, load.length, getSeries);
    const solar = sumSeries('solar', (dev) => (dev.getForecastSeries ? dev.getForecastSeries(startMs, endMs) : null));
    const battery = sumSeries('battery', (dev) => (dev.getPlannedPowerSeries ? dev.getPlannedPowerSeries(startMs, endMs) : null));
    // Away/not plugged in is in the EV plan itself; a car that takes no power is not.
    const ev = sumSeries('evCharger', (dev) => (dev.getPlannedPowerSeries && !(dev.presence && dev.presence.noResponse)
      ? dev.getPlannedPowerSeries(startMs, endMs) : null));
    const netNoBattery = load.map((l, i) => Math.round(l - solar[i] + ev[i]));
    const netPlanned = netNoBattery.map((n, i) => Math.round(n + battery[i]));
    return {
      load, solar, battery, ev, netNoBattery, netPlanned,
    };
  }

  // Flow: an extra load (W) on a day from time (HH:MM) for durationMin; not learned. 0 W removes
  // the one with that start.
  async addPlannedLoad(day, time, durationMin, power) {
    const startOfToday = TimeHelpers.getLocalMidnightUTC(new Date(), this.timeZone);
    const dayStart = day === 'tomorrow'
      ? TimeHelpers.getLocalMidnightUTC(new Date(startOfToday.getTime() + 26 * 60 * 60 * 1000), this.timeZone)
      : startOfToday;
    const from = TimeHelpers.localTimeToUTC(dayStart, time, this.timeZone).getTime();
    const to = from + Math.round(durationMin) * 60 * 1000;
    this.plannedLoads = LoadForecastStrategy.addPlannedLoad(this.plannedLoads, { from, to, power });
    await this.setStoreValue('plannedLoads', this.plannedLoads);
    this.log(`Planned load ${Math.round(power)}W ${day} ${time} for ${durationMin} min`);
    await this.updateForecastDisplay(true);
  }

  sumDriverSeries(driverId, length, getSeries) {
    const total = new Array(length).fill(0);
    let driver = null;
    try {
      driver = this.homey.drivers.getDriver(driverId);
    } catch {
      return total;
    }
    driver.getDevices().forEach((dev) => {
      let series;
      try {
        series = getSeries(dev);
      } catch (err) {
        this.error(err);
        return;
      }
      if (!Array.isArray(series)) return;
      series.forEach((v, i) => {
        if (i < total.length && typeof v === 'number') total[i] += v;
      });
    });
    return total;
  }

  // Power summarizers set as program appliance with enough learned to forecast.
  getApplianceDevices() {
    try {
      return this.homey.drivers.getDriver('power').getDevices()
        .filter((dev) => typeof dev.isApplianceReady === 'function' && dev.isApplianceReady());
    } catch {
      return [];
    }
  }

  getApplianceSeries(startMs, endMs) {
    const length = Math.max(0, Math.ceil((endMs - startMs) / (15 * 60 * 1000)));
    return this.sumDriverSeries('power', length, (dev) => (dev.isApplianceReady && dev.isApplianceReady() ? dev.getForecastSeries(startMs, endMs) : null));
  }

  // Home load forecast (W) per slot: learned load without appliances + planned loads + appliances.
  getHomeLoadSeries(startMs, endMs) {
    const appliances = this.getApplianceSeries(startMs, endMs);
    return LoadForecastStrategy.getLoadSeries(this.weeklyProfile, startMs, endMs, this.timeZone, this.plannedLoads)
      .map((v, i) => v + (appliances[i] || 0));
  }

  getForecastAccuracy() {
    if (!this.forecastAccuracyCache || this.forecastAccuracyCache.errors !== this.forecastErrors) {
      this.forecastAccuracyCache = {
        errors: this.forecastErrors,
        summary: LoadForecastStrategy.summarizeForecastErrors(this.forecastErrors, this.timeZone),
      };
    }
    return this.forecastAccuracyCache.summary;
  }

  // Needs a day of scored slots before the numbers mean much.
  async updateForecastAccuracyStatus() {
    const acc = this.getForecastAccuracy();
    const days = (acc.samples || 0) / 96;
    const text = (acc.samples && days >= 1)
      ? this.homey.__('load_forecast_accuracy', {
        mae: acc.maeW, pct: acc.maePct === null ? '-' : acc.maePct, bias: acc.biasW, days: days.toFixed(1),
      })
      : this.homey.__('load_forecast_accuracy_collecting');
    await this.setSettings({ forecast_accuracy: text });
  }

  // Called by batteries/EV chargers on a plan change and by appliances on a start or end.
  // Debounced: several devices re-plan together on new prices.
  onChargePlanUpdated() {
    if (this.isDestroyed) return;
    if (this.planUpdateTimeout) this.homey.clearTimeout(this.planUpdateTimeout);
    this.planUpdateTimeout = this.homey.setTimeout(() => {
      this.planUpdateTimeout = null;
      if (this.isDestroyed || !this.weeklyProfile) return;
      this.updateForecastDisplay(false, true).catch(this.error);
    }, 10 * 1000);
  }

  async updateForecastDisplay(updated = false, plansChanged = false) {
    const now = new Date();
    // Today and tomorrow (50 h covers a 25 h DST day).
    const slotMs = 15 * 60 * 1000;
    const dayStartMs = TimeHelpers.getLocalMidnightUTC(now, this.timeZone).getTime();
    const appliances = this.getApplianceSeries(dayStartMs, dayStartMs + 50 * 60 * 60 * 1000);
    const forecast = LoadForecastStrategy.calculateForecast({
      weeklyProfile: this.weeklyProfile,
      timestamp: now,
      timezone: this.timeZone,
      plannedLoads: this.plannedLoads,
      extraAt: (t) => appliances[Math.round((t - dayStartMs) / slotMs)] || 0,
    });

    await this.setCapabilityValue('measure_watt_forecast.h0', forecast.expectedPower).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m15', forecast.forecastM15).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m30', forecast.forecastM30).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m45', forecast.forecastM45).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h1', forecast.forecastH1).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h2', forecast.forecastH2).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h3', forecast.forecastH3).catch(this.error);

    await this.setCapabilityValue('meter_kwh_forecast.h0', forecast.forecastH0Kwh).catch(this.error);
    await this.setCapabilityValue('meter_kwh_forecast.this_day', forecast.totalTodayKwh).catch(this.error);
    await this.setCapabilityValue('meter_kwh_forecast.tomorrow', forecast.totalTomorrowKwh).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.tomorrow_peak', forecast.tomorrowPeakW).catch(this.error);

    const slotStartMs = now.getTime() - (now.getTime() % (15 * 60 * 1000));
    const next = this.getNetForecast(slotStartMs, slotStartMs + 75 * 60 * 1000);
    const netNext = next.netPlanned;
    const lastNet = this.netForecastHistory[this.netForecastHistory.length - 1];
    if (!lastNet || lastNet.time !== slotStartMs) {
      this.netForecastHistory.push({ time: slotStartMs, net: netNext[0], load: next.load[0] });
      if (this.netForecastHistory.length > 200) this.netForecastHistory.shift(); // > 2 days incl. a 25 h DST day
      this.fileStore.set('netForecastHistory', this.netForecastHistory);
    }
    await this.setCapabilityValue('measure_watt_forecast.net_h0', netNext[0]).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.net_h1', netNext[4]).catch(this.error);

    const { slotIndex: currentSlot } = LoadForecastStrategy.getLocalTimeDetails(now, this.timeZone);

    const { timeZone } = this;
    const getLocalMidnightUTC = (d) => TimeHelpers.getLocalMidnightUTC(d, timeZone);

    // Real local midnights (DST days have 23 or 25 hours).
    const startOfToday = getLocalMidnightUTC(now);
    const startOfTomorrow = getLocalMidnightUTC(new Date(startOfToday.getTime() + 26 * 60 * 60 * 1000));
    const endOfToday = startOfTomorrow;
    const endOfTomorrow = getLocalMidnightUTC(new Date(startOfTomorrow.getTime() + 26 * 60 * 60 * 1000));
    const startOfYesterday = getLocalMidnightUTC(new Date(startOfToday.getTime() - 60 * 60 * 1000));
    const endOfYesterday = startOfToday;

    // The charts are not time-critical: after a slot boundary's burst (LoadSpread).
    // Calls merged into one deferred run: what any of them changed is drawn.
    const flags = { updated, plansChanged, quarter: now.getMinutes() % 15 === 0 };
    await LoadSpread.run(this, 'forecastCharts', async ({ updated: modelUpdated, plansChanged: plansMoved, quarter }) => {
      // Grid exchange charts. Today/Tomorrow refresh every 15 minutes, as the battery/EV plans
      // change independently of the load model. Past slots show the recorded forecast.
      const recordedNet = new Map(this.netForecastHistory.map((e) => [e.time, e.net]));
      const gridOpts = (startMs, endMs) => ({
        forecast: this.getNetForecast(startMs, endMs).netPlanned.map((v, i) => {
          const t = startMs + (i * 15 * 60 * 1000);
          if (t >= slotStartMs) return v;
          return recordedNet.has(t) ? recordedNet.get(t) : null;
        }),
        realKey: 'grid',
        signed: true,
      });
      if (modelUpdated || plansMoved || quarter || !this.chartNetToday) {
        const chart = await getGridForecastChart(null, startOfToday, endOfToday, 'Grid Today', this.powerHistory, this.timeZone, true, gridOpts(startOfToday.getTime(), endOfToday.getTime()));
        if (chart) {
          this.chartNetToday = chart;
          await this.netTodayImage.update().catch(this.error);
        }
      }
      if (modelUpdated || plansMoved || quarter || !this.chartNetTomorrow) {
        const chart = await getGridForecastChart(null, startOfTomorrow, endOfTomorrow, 'Grid Tomorrow', [], this.timeZone, false, gridOpts(startOfTomorrow.getTime(), endOfTomorrow.getTime()));
        if (chart) {
          this.chartNetTomorrow = chart;
          await this.netTomorrowImage.update().catch(this.error);
        }
      }
      if (modelUpdated || !this.chartNetYesterday) {
        const opts = gridOpts(startOfYesterday.getTime(), endOfYesterday.getTime());
        const chart = await getGridForecastChart(null, startOfYesterday, endOfYesterday, 'Grid Yesterday', this.powerHistory, this.timeZone, false, opts);
        if (chart) {
          this.chartNetYesterday = chart;
          await this.netYesterdayImage.update().catch(this.error);
        }
      }

      if (modelUpdated || !this.chartGridWeekly) {
        const chartWeekly = await getGridWeeklyChart(this.weeklyProfile, 'Weekly Baseline Profile');
        if (chartWeekly) {
          this.chartGridWeekly = chartWeekly;
          await this.gridWeeklyImage.update().catch(this.error);
        }
      }
    }, flags);

    if (updated || this.lastTriggerSlot !== currentSlot) {
      this.lastTriggerSlot = currentSlot;
      await this.flows.triggerForecastUpdated().catch((err) => this.error('Error triggering load forecast updated flows', err));
    }
  }

  async retrainLoadModel(fromScratch = false) {
    if (this.retrainingLoad) {
      this.log('Already retraining load model, skipping...');
      return;
    }
    this.retrainingLoad = true;
    this.log(`Starting load model retraining... (Mode: ${fromScratch ? 'From Scratch' : 'Blend'})`);

    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch { }
      if (!api) throw new Error('Homey API not ready');

      // Train from the physical source devices' Insights, never from this device's own derived
      // measure_watt_home log (short-lived output of this forecaster).
      let allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const powerEntries = await this.reconstructHomePowerHistory(api, allLogs, null, null, null, true).catch((err) => {
        this.error('History reconstruction failed:', err);
        return [];
      });

      if (powerEntries.length === 0) {
        this.log('[retrainLoadModel] History reconstruction yielded no data. '
          + 'The forecaster will learn dynamically. Initializing weekly profile with default baseline.');
        if (!this.weeklyProfile) {
          this.weeklyProfile = LoadForecastStrategy.initializeProfile();
          await this.setStoreValue('weeklyProfile', this.weeklyProfile);
        }
        await this.updateForecastDisplay();
        return;
      }

      // Not merged into this.powerHistory: these are ~hourly, the charts need 5-minute samples
      // (populatePowerHistory()).

      const trainingProfile = fromScratch ? LoadForecastStrategy.initializeProfile() : this.weeklyProfile;

      const result = LoadForecastStrategy.processHistoricData({
        powerEntries,
        currentWeeklyProfile: trainingProfile,
        timezone: this.timeZone,
        logger: (msg) => this.log(msg),
        maxPowerW: this.getHomePowerCeilingW(),
        plannedLoads: this.plannedLoads,
        minSamples: fromScratch ? 1 : 2,
      });

      if (result.updated) {
        this.weeklyProfile = result.weeklyProfile;
        await this.setStoreValue('weeklyProfile', this.weeklyProfile);
        await this.updateForecastDisplay(true);
        this.log('Retraining load model finished successfully.');
      } else {
        this.log('Retraining load model produced no updates.');
        await this.updateForecastDisplay(true);
      }

    } catch (err) {
      this.error('Retraining load model failed:', err);
    } finally {
      this.retrainingLoad = false;
    }
  }

  async populatePowerHistory() {
    try {
      const now = new Date();
      const nowMs = now.getTime();

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      // Ignore entries written during this startup, so one boot-time entry does not count as recent.
      const preStartupHistory = this.powerHistory.filter((e) => e.time < (this.startupTime || 0));
      const hasData = preStartupHistory.length > 24 && preStartupHistory[0].time < (nowMs - 40 * 60 * 60 * 1000);
      const hasRecent = preStartupHistory.length > 0 && preStartupHistory[preStartupHistory.length - 1].time > (nowMs - 6 * 60 * 60 * 1000);
      // History from before grid values were recorded needs one backfill for the Grid charts.
      const hasGrid = preStartupHistory.some((e) => typeof e.grid === 'number');

      if (hasData && hasRecent && hasGrid) {
        return;
      }

      this.log('Populating power history from Insights...');

      let api;
      try {
        api = this.homey.app.api;
      } catch { }
      if (!api) {
        this.log('Homey API not ready');
        return;
      }

      // From the physical source devices, as in retrainLoadModel().
      let allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const powerEntries = await this.reconstructHomePowerHistory(api, allLogs, null, null, 'yesterday').catch((err) => {
        this.error('History reconstruction failed:', err);
        return [];
      });

      if (powerEntries.length > 0) {
        const ceilingW = this.getHomePowerCeilingW();
        // Round to 5 minutes against duplicates from mixed resolutions.
        const roundTo5Min = (t) => Math.round(t / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const historyMapped = powerEntries
          .map((e) => {
            const time = roundTo5Min(new Date(e.t).getTime());
            let power = 0;
            if (typeof e.v === 'number') power = Math.round(e.v);
            else if (typeof e.y === 'number') power = Math.round(e.y);
            return { time, power, grid: typeof e.grid === 'number' ? e.grid : null };
          })
          .filter((e) => e.power >= 0 && e.power <= ceilingW);

        if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
        const existingMap = new Map(this.powerHistory.map((e) => [roundTo5Min(e.time), e]));
        historyMapped.forEach((entry) => {
          existingMap.set(entry.time, entry);
        });

        this.powerHistory = Array.from(existingMap.values());
        this.powerHistory.sort((a, b) => a.time - b.time);
        if (this.powerHistory.length > 576) this.powerHistory = this.powerHistory.slice(-576);
        this.fileStore.set('powerHistory', this.powerHistory);
        this.lastPowerHistorySaveTm = Date.now();
        this.log(`Merged ${historyMapped.length} historical entries into powerHistory. Total length: ${this.powerHistory.length}`);
        await this.updateForecastDisplay(true);
      }
    } catch (err) {
      this.error('Error populating power history:', err);
    }
  }

  // withoutAppliances: the home load to learn, without program appliances.
  async reconstructHomePowerHistory(api, allLogs, customStart = null, customEnd = null, customResolution = null, withoutAppliances = false) {
    const endDate = customEnd || new Date();
    const startDate = customStart || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 14);
      return d;
    })();
    // Hourly history: 'last14Days' when it is hourly, else 'last7Days' (InsightsHistory). Chosen on
    // the first log read, then the same for all, so every component covers the same days.
    let resolution = customResolution;
    const fetchEntries = async (logId) => {
      if (resolution) {
        return api.insights.getLogEntries({
          id: logId, start: startDate.toISOString(), end: endDate.toISOString(), resolution,
        }).catch(() => null);
      }
      let data = null;
      for (const res of ['last14Days', 'last7Days']) {
        data = await api.insights.getLogEntries({
          id: logId, start: startDate.toISOString(), end: endDate.toISOString(), resolution: res,
        }).catch(() => null);
        if (data && data.values && data.values.length && InsightsHistory.stepOf(data) <= InsightsHistory.HOUR_MS) {
          resolution = res;
          this.log(`[Grid] Home power history from Insights '${res}' (hourly)`);
          return data;
        }
      }
      return null;
    };

    const getLogEntriesForDevice = async (deviceId, endings) => {
      const deviceLogs = allLogs.filter((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(deviceId) && !logId.includes('PH_');
      });

      const matchingLogsMap = new Map();

      deviceLogs.forEach((log) => {
        const logId = log.id || log.uri || '';
        const matchIndex = endings.findIndex((ending) => logId.endsWith(ending));
        if (matchIndex !== -1) {
          matchingLogsMap.set(logId, { log, priority: matchIndex, isCumulative: logId.includes(':meter_power') });
        }
      });

      if (matchingLogsMap.size === 0) return null;

      // With a grand total meter (':meter_power'), drop its sub-totals (.t1, .imported) against double
      // counting; phase (.l1-.l3) and tariff (.t1/.t2) meters alone are summed.
      let finalLogs = Array.from(matchingLogsMap.values());
      const hasBaseMeterPower = finalLogs.some((item) => (item.log.id || item.log.uri || '').endsWith(':meter_power'));

      if (hasBaseMeterPower) {
        finalLogs = finalLogs.filter((item) => {
          const id = item.log.id || item.log.uri || '';
          return id.endsWith(':meter_power') || id.endsWith(':meter_power.exported');
        });
      }

      try {
        const allEntries = [];
        for (let i = 0; i < finalLogs.length; i++) {
          const { log, isCumulative } = finalLogs[i];

          // Insights resolution 'yesterday' always returns the previous calendar day and ignores
          // start/end (confirmed live): fetchYesterdayAndToday() adds 'today'.
          const logData = resolution === 'yesterday'
            ? await fetchYesterdayAndToday(api, log.id)
            : await fetchEntries(log.id);

          if (logData && logData.values && logData.values.length > 0) {
            let { values } = logData;
            if (isCumulative) {
              values = convertCumulativeToPower(values, this.getHomePowerCeilingW());
            }
            allEntries.push(...values.map((e) => ({
              t: new Date(e.t).getTime(),
              v: e.y !== undefined ? e.y : e.v,
            })));
          }
        }

        if (allEntries.length > 0) {
          // Sum per timestamp (e.g. tariff 1 + tariff 2)
          const timeMap = new Map();
          allEntries.forEach((e) => {
            const currentVal = timeMap.get(e.t) || 0;
            timeMap.set(e.t, currentVal + e.v);
          });
          return Array.from(timeMap.entries()).map(([t, v]) => ({ t, v }));
        }
      } catch (err) {
        this.error(`Failed to fetch log entries for device ${deviceId}:`, err);
      }
      return null;
    };

    const sourceDevice = await this.getSourceDevice();
    if (!sourceDevice) {
      this.log('No grid source device found. Cannot reconstruct.');
      return [];
    }

    // 1. Grid: real-time power first, else cumulative import/export. Homey logs measure_power under
    // ':energy_power'; a ':measure_power' log can exist but is empty (skill section 3).
    let gridEntries = [];
    const measurePowerEntries = await getLogEntriesForDevice(sourceDevice.id, [
      ':energy_power',
    ]);
    const measurePowerExportEntries = await getLogEntriesForDevice(sourceDevice.id, [
      ':measure_power.exported',
    ]);

    if (measurePowerEntries && measurePowerEntries.length > 0) {
      gridEntries = measurePowerEntries;
    }

    let importPowerEntries = [];
    let exportPowerEntries = [];
    if (gridEntries.length === 0) {
      const importEntries = await getLogEntriesForDevice(sourceDevice.id, [
        ':meter_power', ':meter_power.imported', ':meter_power.grid',
        ':meter_power.t1', ':meter_power.t2', ':meter_power.imported.t1', ':meter_power.imported.t2',
        ':meter_power.import', ':meter_power.total_power',
      ]);
      const exportEntries = await getLogEntriesForDevice(sourceDevice.id, [
        ':meter_power.exported', ':meter_power.t3', ':meter_power.t4',
        ':meter_power.exported.t1', ':meter_power.exported.t2',
        ':meter_power.rt1', ':meter_power.rt2', ':meter_power.export',
      ]);

      if (importEntries) {
        importPowerEntries = importEntries;
      }
      if (exportEntries) {
        exportPowerEntries = exportEntries;
      }
    }

    if (gridEntries.length === 0 && importPowerEntries.length === 0) {
      this.log('No grid power entries or cumulative meter logs found. Cannot reconstruct.');
      return [];
    }

    // Per component: instantaneous power before meter_power, so W and kWh-derived W are not mixed.
    // Resolved to the physical device via its 'homey_device_id' setting: resolving PowerHour devices
    // via data.id gives back the PowerHour device itself (confirmed 2026-08-10).
    // Per device, so several devices of one type are summed, not averaged.
    const solarEntriesList = [];
    const solarDriver = this.homey.drivers.getDriver('solar');
    if (solarDriver) {
      for (const dev of solarDriver.getDevices()) {
        const devId = dev.getSettings().homey_device_id;
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':energy_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) solarEntriesList.push({ devId, entries });
      }
    }

    const batteryEntriesList = [];
    const batDriver = this.homey.drivers.getDriver('battery');
    if (batDriver) {
      for (const dev of batDriver.getDevices()) {
        const devId = dev.getSettings().homey_device_id;
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':measure_watt_avg', ':energy_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) batteryEntriesList.push({ devId, entries });
      }
    }

    const evEntriesList = [];
    const evDriver = this.homey.drivers.getDriver('evCharger');
    if (evDriver) {
      for (const dev of evDriver.getDevices()) {
        const devId = dev.getSettings().homey_device_id;
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':measure_watt_avg', ':energy_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) evEntriesList.push({ devId, entries });
      }
    }

    const applianceEntriesList = [];
    if (withoutAppliances) {
      for (const dev of this.getApplianceDevices()) {
        const devId = dev.getSettings().homey_device_id;
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [':energy_power']);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) applianceEntriesList.push({ devId, entries });
      }
    }

    // Combination per bucket is in HomePowerReconstruction.js (shared with offline analysis).
    let gridImportEntries = [];
    let gridExportEntries = [];
    if (gridEntries.length > 0) {
      gridImportEntries = gridEntries;
      // Power never negative but export entries exist: add them to the export.
      const hasNegative = gridEntries.some((e) => (e.y !== undefined ? e.y : e.v) < -1);
      if (!hasNegative && measurePowerExportEntries && measurePowerExportEntries.length > 0) {
        gridExportEntries = measurePowerExportEntries;
      }
    } else {
      gridImportEntries = importPowerEntries;
      gridExportEntries = exportPowerEntries;
    }

    const reconstructed = combineComponentsToHomePower({
      gridImportEntries,
      gridExportEntries,
      solarEntriesList,
      batteryEntriesList,
      evEntriesList,
      applianceEntriesList,
      logger: (msg) => this.log(msg),
      maxPowerW: this.getHomePowerCeilingW(),
    });

    this.log(`Successfully reconstructed ${reconstructed.length} home power entries from component history.`);
    return reconstructed;
  }

  destroyListeners() {
    super.destroyListeners();
    this.phaseW = null;
    this.phaseHistory = null;
    if (this.retrainLoadListener) {
      this.retrainLoadListener.destroy();
      this.retrainLoadListener = null;
    }
  }

  stopPolling() {
    super.stopPolling();
    // Bump the epochs, so invocations already running do not reschedule (see startForecastLoop()).
    this.forecastEpoch = (this.forecastEpoch || 0) + 1;
    this.learningEpoch = (this.learningEpoch || 0) + 1;
    if (this.forecastTimeout) {
      this.homey.clearTimeout(this.forecastTimeout);
      this.forecastTimeout = null;
    }
    if (this.learningTimeout) {
      this.homey.clearTimeout(this.learningTimeout);
      this.learningTimeout = null;
    }
    if (this.initLearningTimeout) {
      this.homey.clearTimeout(this.initLearningTimeout);
      this.initLearningTimeout = null;
    }
    if (this.initialBackfillRetryTimeout) {
      this.homey.clearTimeout(this.initialBackfillRetryTimeout);
      this.initialBackfillRetryTimeout = null;
    }
    if (this.planUpdateTimeout) {
      this.homey.clearTimeout(this.planUpdateTimeout);
      this.planUpdateTimeout = null;
    }
  }
}

module.exports = GridDevice;
