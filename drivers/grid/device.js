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
const LoadForecastStrategy = require('../../lib/helpers/LoadForecastStrategy');
const GridFlows = require('../../lib/flows/GridFlows');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const { getGridForecastChart, getGridWeeklyChart } = require('../../lib/charts/GridChart');

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
    meter_source: 'meter_power.grid',
    measure_source: 'measure_power.grid',
  },
};

class GridDevice extends GenericDevice {
  async onInit() {
    this.startupTime = Date.now(); // Fix 1: stamp startup so boot-time entries can be excluded from guard
    this.powerHistory = [];
    this.ds = deviceSpecifics;
    this.flows = new GridFlows(this);
    await super.onInit().catch(this.error);

    // Load forecast settings and profiles
    this.timeZone = this.homey.clock.getTimezone();
    const storedProfile = await this.getStoreValue('weeklyProfile');
    this.weeklyProfile = storedProfile || LoadForecastStrategy.initializeProfile();
    this.lastAutoRetrainLoad = await this.getStoreValue('lastAutoRetrainLoad') || 0;
    this.retrainingLoad = false;

    // Load power history
    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    this.powerHistory = history
      .map((e) => {
        const time = e.time || (e.t ? new Date(e.t).getTime() : Date.now());
        let power = 0;
        if (typeof e.power === 'number') power = e.power;
        else if (typeof e.v === 'number') power = e.v;
        else if (typeof e.y === 'number') power = e.y;
        return { time, power };
      })
      .filter((e) => e.power >= 0 && e.power <= 30000)
      .slice(-2880);

    // Register button capability listener
    this.retrainLoadListener = this.registerCapabilityListener('button.retrain_load', async () => {
      await this.retrainLoadModel(true); // From scratch
      return true;
    });

    // Start Loops
    this.startForecastLoop();
    if (this.initLearningTimeout) this.homey.clearTimeout(this.initLearningTimeout);
    this.initLearningTimeout = this.homey.setTimeout(async () => {
      await this.populatePowerHistory();
      await this.updateForecastDisplay();
      if (!storedProfile) {
        this.log('First initialization: Auto-starting load model retraining...');
        await this.retrainLoadModel(true); // First run: Start fresh
      }
      this.startLearningLoop();
      this.initLearningTimeout = null;
    }, 15000);
  }

  async initDeviceValues() {
    this.meterPowerHome = await this.getStoreValue('meterPowerHome') || 0;
    if (this.hasCapability('meter_power.home')) {
      await this.setCapabilityValue('meter_power.home', this.meterPowerHome).catch(this.error);
    }
    await super.initDeviceValues();
  }

  async setCapability(capability, value) {
    await super.setCapability(capability, value);
    // Calculate home power real-time in sync with the grid power updates
    if (capability === 'measure_power.grid') {
      this.calculateHomePower().catch(this.error);
    }
  }

  async calculateHomePower() {
    try {
      const gridPower = this.getCapabilityValue('measure_power.grid') || 0;

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

      // Fallback to central Homey Energy report if no PbtH solar devices are found
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

      // Wiskunde voor eigen verbruik: Grid (import = +) + Solar (prod = +) - Battery (laden = +) - EV (laden = +)
      const homePower = Math.round(gridPower + solarPower - batteryPower - evPower);

      // Apply a 2-minute rolling average to eliminate ghost spikes caused by timing mismatches.
      // Grid (P1), battery and solar meters all report at different cadences. When the battery
      // switches charge/discharge state, the grid and battery measures can be out of sync by
      // 10–30 s, causing the formula to temporarily double-count the battery contribution.
      const now = Date.now();
      if (!Array.isArray(this.homePowerBuffer)) this.homePowerBuffer = [];
      if (homePower >= 0 && homePower <= 30000) {
        this.homePowerBuffer.push({ time: now, value: homePower });
      }
      this.homePowerBuffer = this.homePowerBuffer.filter((e) => now - e.time <= 2 * 60 * 1000);
      const smoothedHomePower = this.homePowerBuffer.length > 0
        ? Math.round(this.homePowerBuffer.reduce((sum, e) => sum + e.value, 0) / this.homePowerBuffer.length)
        : Math.max(0, homePower);
      const safeHomePower = Math.max(0, Math.min(30000, smoothedHomePower));
      await this.setCapability('measure_power.home', safeHomePower).catch(this.error);

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      if (typeof safeHomePower === 'number' && safeHomePower >= 0 && safeHomePower <= 30000) {
        const lastEntry = this.powerHistory[this.powerHistory.length - 1];
        // The 576-entry cap is sized for 48h of 5-minute-spaced samples (576 * 5min = 48h), matching
        // the Insights-merge granularity in populatePowerHistory/retrainLoadModel. A push interval
        // shorter than 5 minutes fills the array much faster than that, evicting the merged multi-day
        // history within a few hours of any restart/retrain instead of the intended 48h.
        if (!lastEntry || (now - lastEntry.time) > 5 * 60 * 1000) {
          this.powerHistory.push({ time: now, power: safeHomePower });
          if (this.powerHistory.length > 576) this.powerHistory.shift();
          if (!this.lastPowerHistorySaveTm || (now - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
            this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
            this.lastPowerHistorySaveTm = now;
          }
        }
      }
      if (this.lastHomePowerCalcTm) {
        const dt = now - this.lastHomePowerCalcTm; // ms
        if (dt > 0 && dt < 300000) {
          const safePower = Math.max(0, this.lastHomePower || 0);
          const deltaKwh = (safePower * dt) / 3600000000;
          this.meterPowerHome = (this.meterPowerHome || 0) + deltaKwh;
          await this.setCapability('meter_power.home', Number(this.meterPowerHome.toFixed(4))).catch(this.error);

          if (!this.lastHomePowerSaveTm || (now - this.lastHomePowerSaveTm > 60000)) {
            this.setStoreValue('meterPowerHome', this.meterPowerHome).catch(this.error);
            this.lastHomePowerSaveTm = now;
          }
        }
      }
      this.lastHomePower = safeHomePower;
      this.lastHomePowerCalcTm = now;
    } catch (err) {
      this.error('Error calculating home power:', err);
    }
  }

  getActiveTariff(reading, tariff, exportTariff) {
    const settings = this.getSettings();
    const tariffType = settings?.tariff_type || 'dynamic';
    if (tariffType === 'import') return tariff;
    if (tariffType === 'export') return exportTariff;

    let deltaMeter;
    if (this.meterMoney && typeof this.meterMoney.meterValue === 'number' && typeof reading.meterValue === 'number') {
      deltaMeter = reading.meterValue - this.meterMoney.meterValue;
    }

    if (typeof deltaMeter === 'number' && deltaMeter !== 0) {
      return deltaMeter < 0 ? exportTariff : tariff;
    }

    // 1. Use local values for the main meter device
    const livePower = this.getCapabilityValue(this.ds.cmap.measure_source);
    if (typeof livePower === 'number') return livePower < 0 ? exportTariff : tariff;

    // 2. Default to import tariff
    return tariff;
  }

  async addSourceCapGroup() {
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters

    const energyData = this.sourceDevice.energyObj || this.sourceDevice.energy;

    if (energyData && energyData.cumulative === true) {
      const importedCap = energyData.cumulativeImportedCapability || 'meter_power';
      const exportedCap = energyData.cumulativeExportedCapability;

      const group = {
        p1: null, p2: null, n1: null, n2: null,
      };

      if (this.sourceDevice.capabilities.includes(importedCap)) {
        group.p1 = importedCap;
      }

      if (exportedCap && this.sourceDevice.capabilities.includes(exportedCap)) {
        group.n1 = exportedCap;
      }

      if (group.p1 || group.n1) {
        this.sourceCapGroup = group;
        return;
      }
    }

    throw Error(`${this.sourceDevice.name} has no compatible grid capabilities defined in the energy object.`);
  }

  // --- Load Forecast Logic ---

  async startForecastLoop() {
    let firstRun = true;
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        // Skip the nightly retrain check on the very first invocation (startup)
        // to avoid conflicting with the explicit startup retraining in initLearningTimeout.
        if (!firstRun) {
          const now = new Date();
          const localNow = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
          if (localNow.getHours() === 2) {
            const lastRun = new Date(this.lastAutoRetrainLoad);
            const isSameDay = lastRun.getDate() === localNow.getDate() && lastRun.getMonth() === localNow.getMonth() && lastRun.getFullYear() === localNow.getFullYear();

            if (!isSameDay) {
              this.log('Running automatic nightly load model retraining...');
              await this.retrainLoadModel(false); // Nightly: Blend with existing data
              this.lastAutoRetrainLoad = now.getTime();
              await this.setStoreValue('lastAutoRetrainLoad', this.lastAutoRetrainLoad);
            }
          }
        }
      } catch (err) {
        this.error('Load forecast loop failed:', err);
      } finally {
        firstRun = false;
        if (!this.isDestroyed) {
          this.forecastTimeout = this.homey.setTimeout(loop, 60 * 60 * 1000); // 1 hour
        }
      }
    };
    await loop();
  }

  async startLearningLoop() {
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        if (!this.retrainingLoad) {
          const updated = await this.updateLearning();
          await this.updateForecastDisplay(updated);
        }
      } catch (err) {
        this.error('Load learning update failed:', err);
      } finally {
        if (!this.isDestroyed) {
          const now = new Date();
          const nextSlot = new Date(now);
          nextSlot.setMinutes(now.getMinutes() + 1, 0, 0);
          let delay = nextSlot - now;
          if (delay < 1000) delay += 60 * 1000;
          this.learningTimeout = this.homey.setTimeout(loop, delay);
        }
      }
    };
    await loop();
  }

  async updateLearning() {
    let updated = false;
    const now = new Date();
    const currentTimestamp = now.getTime();

    const rawPower = this.getCapabilityValue('measure_power.home');
    const currentEnergy = this.getCapabilityValue('meter_power.home');

    const { smoothedPower, newEnergyState } = LoadForecastStrategy.calculateSmoothedPower({
      currentPower: rawPower,
      currentEnergy,
      lastEnergyState: this.lastEnergyState,
      currentTimestamp,
    });
    this.lastEnergyState = newEnergyState;
    const currentPower = smoothedPower;

    // Bug 4: only proceed if we have a valid numeric power reading
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

      const result = LoadForecastStrategy.getStrategy({
        currentPower: bucketResult.finishedBucket.avgPower,
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

  async updateForecastDisplay(updated = false) {
    const now = new Date();
    const forecast = LoadForecastStrategy.calculateForecast({
      weeklyProfile: this.weeklyProfile,
      timestamp: now,
      timezone: this.timeZone,
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

    const { slotIndex: currentSlot } = LoadForecastStrategy.getLocalTimeDetails(now, this.timeZone);

    // --- Update Charts ---
    // Bug 2: DST-aware local midnight to UTC conversion (two-pass method)
    const { timeZone } = this;
    const getLocalMidnightUTC = (d) => {
      const homeyOffset = new Date(d.toLocaleString('en-US', { timeZone })).getTime() - d.getTime();
      const local = new Date(d.getTime() + homeyOffset);
      local.setHours(0, 0, 0, 0);
      const midnightUTCEstimate = new Date(local.getTime() - homeyOffset);
      // Second pass: verify and correct for DST boundary
      const checkLocal = new Date(midnightUTCEstimate.toLocaleString('en-US', { timeZone }));
      const diff = local.getTime() - checkLocal.getTime();
      return new Date(midnightUTCEstimate.getTime() + diff);
    };

    const startOfToday = getLocalMidnightUTC(now);
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const endOfYesterday = startOfToday;

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const startOfTomorrow = getLocalMidnightUTC(tomorrow);
    const endOfTomorrow = new Date(startOfTomorrow.getTime() + 24 * 60 * 60 * 1000);

    // 1. Yesterday Chart (Forecast vs Real)
    if (updated || !this.gridYesterdayImage) {
      const chartYesterday = await getGridForecastChart(this.weeklyProfile, startOfYesterday, endOfYesterday, 'In-house Usage Yesterday', this.powerHistory, this.timeZone, false);
      if (chartYesterday) {
        this.chartGridYesterday = chartYesterday;
        if (!this.gridYesterdayImage) {
          this.gridYesterdayImage = await this.homey.images.createImage();
          this.gridYesterdayImage.setStream(async (stream) => imageUrlToStream(this.chartGridYesterday, stream, this));
          await this.setCameraImage('gridYesterday', ` ${this.homey.__('yesterday')}`, this.gridYesterdayImage);
        }
        await this.gridYesterdayImage.update().catch(this.error);
      }
    }

    // 2. Today Chart (Forecast vs Real - updated every 15 mins or on model update)
    if (updated || (now.getMinutes() % 15 === 0) || !this.gridTodayImage) {
      const chartToday = await getGridForecastChart(this.weeklyProfile, startOfToday, endOfToday, 'In-house Usage Today', this.powerHistory, this.timeZone, true);
      if (chartToday) {
        this.chartGridToday = chartToday;
        if (!this.gridTodayImage) {
          this.gridTodayImage = await this.homey.images.createImage();
          this.gridTodayImage.setStream(async (stream) => imageUrlToStream(this.chartGridToday, stream, this));
          await this.setCameraImage('gridToday', ` ${this.homey.__('today')}`, this.gridTodayImage);
        }
        await this.gridTodayImage.update().catch(this.error);
      }
    }

    // 3. Tomorrow Chart (Forecast only)
    if (updated || !this.gridTomorrowImage) {
      const chartTomorrow = await getGridForecastChart(this.weeklyProfile, startOfTomorrow, endOfTomorrow, 'In-house Usage Tomorrow', [], this.timeZone, false);
      if (chartTomorrow) {
        this.chartGridTomorrow = chartTomorrow;
        if (!this.gridTomorrowImage) {
          this.gridTomorrowImage = await this.homey.images.createImage();
          this.gridTomorrowImage.setStream(async (stream) => imageUrlToStream(this.chartGridTomorrow, stream, this));
          await this.setCameraImage('gridTomorrow', ` ${this.homey.__('tomorrow')}`, this.gridTomorrowImage);
        }
        await this.gridTomorrowImage.update().catch(this.error);
      }
    }

    // 4. Weekly Chart (Monday to Sunday baseline profile)
    if (updated || !this.gridWeeklyImage) {
      const chartWeekly = await getGridWeeklyChart(this.weeklyProfile, 'Weekly Baseline Profile');
      if (chartWeekly) {
        this.chartGridWeekly = chartWeekly;
        if (!this.gridWeeklyImage) {
          this.gridWeeklyImage = await this.homey.images.createImage();
          this.gridWeeklyImage.setStream(async (stream) => imageUrlToStream(this.chartGridWeekly, stream, this));
          await this.setCameraImage('gridWeekly', ` ${this.homey.__('weekly')}`, this.gridWeeklyImage);
        }
        await this.gridWeeklyImage.update().catch(this.error);
      }
    }

    if (updated || this.lastTriggerSlot !== currentSlot) {
      this.lastTriggerSlot = currentSlot;
      await this.flows.triggerForecastUpdated().catch((err) => this.error('Error triggering load forecast updated flows', err));
    }
  }

  /**
   * Resolve this device's own Homey device UUID (as used in Insights log IDs:
   * 'homey:device:<UUID>:<capability>'). getData().id is this app's own synthetic
   * pairing ID (e.g. 'PH_grid_<sourceId>_<random>') and never appears in Insights log
   * IDs, so it cannot be used to find this device's own logs directly. Instead, find
   * this device inside the full device list by matching on the preserved pairing data.
   */
  async getOwnHomeyDeviceId(api) {
    if (this._ownHomeyDeviceId) return this._ownHomeyDeviceId;
    try {
      const ownDataId = this.getData().id;
      const allDevices = await api.devices.getDevices().catch(() => null);
      if (!allDevices) return null;
      const match = Object.values(allDevices).find((d) => d && d.data && d.data.id === ownDataId);
      if (match && match.id) {
        this._ownHomeyDeviceId = match.id;
        return this._ownHomeyDeviceId;
      }
    } catch (err) {
      this.error('Error resolving own Homey device id:', err);
    }
    return null;
  }

  /**
   * Same resolution as getOwnHomeyDeviceId, but for arbitrary powerhour devices (e.g. the
   * solar/battery/evCharger component devices used by reconstructHomePowerHistory): maps each
   * device's synthetic pairing id (getData().id) to its real Homey UUID, since only the UUID
   * appears in Insights log ids.
   */
  async resolveHomeyDeviceIdMap(api) {
    if (this._homeyDeviceIdMap) return this._homeyDeviceIdMap;
    const map = new Map();
    try {
      const allDevices = await api.devices.getDevices().catch(() => null);
      if (allDevices) {
        Object.values(allDevices).forEach((d) => {
          if (d && d.data && d.data.id && d.id) map.set(d.data.id, d.id);
        });
      }
    } catch (err) {
      this.error('Error resolving Homey device id map:', err);
    }
    this._homeyDeviceIdMap = map;
    return map;
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
      } catch (e) { }
      if (!api) throw new Error('Homey API not ready');

      // 1. Locate Insights Log for home power capability
      let allLogs = await api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const ownHomeyDeviceId = await this.getOwnHomeyDeviceId(api);
      const targetLog = ownHomeyDeviceId ? allLogs.find((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(ownHomeyDeviceId) && logId.endsWith(':measure_power.home');
      }) : null;

      let powerEntries = [];

      if (targetLog) {
        this.log(`Found target log: ${targetLog.name || 'unknown'} (ID: ${targetLog.id})`);

        const endDate = new Date();
        const startDate14 = new Date();
        startDate14.setDate(startDate14.getDate() - 14);

        try {
          const logs14 = await api.insights.getLogEntries({
            id: targetLog.id,
            start: startDate14.toISOString(),
            end: endDate.toISOString(),
            resolution: 'last14Days',
          });

          if (logs14 && logs14.values && logs14.values.length > 0) {
            this.log(`Got ${logs14.values.length} log entries from Insights.`);
            powerEntries = logs14.values;
          }
        } catch (err) {
          this.error('Failed to retrieve log entries for targetLog:', err);
        }
      }

      if (powerEntries.length === 0) {
        this.log('[retrainLoadModel] Insights log for measure_power.home is empty or missing. '
          + 'Attempting to reconstruct from Grid, Solar, Battery, and EV charger logs...');
        powerEntries = await this.reconstructHomePowerHistory(api, allLogs).catch((err) => {
          this.error('History reconstruction failed:', err);
          return [];
        });
      }

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

      if (powerEntries.length > 0) {
        // Bug 5: round Insights timestamps to nearest 5 minutes before keying the merge Map
        // to avoid duplicates when mixing 5-min Insights resolution with ms-precision real-time entries.
        const roundTo5Min = (t) => Math.round(t / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const historyMapped = powerEntries
          .map((e) => {
            const time = roundTo5Min(new Date(e.t).getTime());
            let power = 0;
            if (typeof e.v === 'number') power = Math.round(e.v);
            else if (typeof e.y === 'number') power = Math.round(e.y);
            return { time, power };
          })
          .filter((e) => e.power >= 0 && e.power <= 30000);
        if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
        // Also round existing real-time entries before merging
        const existingMap = new Map(this.powerHistory.map((e) => [roundTo5Min(e.time), e]));
        historyMapped.forEach((entry) => {
          existingMap.set(entry.time, entry);
        });
        this.powerHistory = Array.from(existingMap.values());
        this.powerHistory.sort((a, b) => a.time - b.time);
        if (this.powerHistory.length > 576) this.powerHistory = this.powerHistory.slice(-576);
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.lastPowerHistorySaveTm = Date.now();
        this.log(`Merged ${historyMapped.length} historical entries into powerHistory. Total length: ${this.powerHistory.length}`);
      }

      // 2. Process
      const trainingProfile = fromScratch ? LoadForecastStrategy.initializeProfile() : this.weeklyProfile;

      const result = LoadForecastStrategy.processHistoricData({
        powerEntries,
        currentWeeklyProfile: trainingProfile,
        timezone: this.timeZone,
        logger: (msg) => this.log(msg),
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
      // Bug 1: use Date object, not Date.now() number, so .toLocaleString() works correctly
      const now = new Date();
      const nowMs = now.getTime();

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      // Fix 2: Exclude entries written during this startup session (by calculateHomePower firing
      // before/during onInit) so a single boot-time entry doesn't falsely satisfy hasRecent.
      const preStartupHistory = this.powerHistory.filter((e) => e.time < (this.startupTime || 0));
      const hasData = preStartupHistory.length > 24 && preStartupHistory[0].time < (nowMs - 40 * 60 * 60 * 1000);
      const hasRecent = preStartupHistory.length > 0 && preStartupHistory[preStartupHistory.length - 1].time > (nowMs - 6 * 60 * 60 * 1000);

      if (hasData && hasRecent) {
        return;
      }

      this.log('Populating power history from Insights...');

      let api;
      try {
        api = this.homey.app.api;
      } catch (e) { }
      if (!api) {
        this.log('Homey API not ready');
        return;
      }

      // Locate Insights Log for home power capability
      let allLogs = await api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const ownHomeyDeviceId = await this.getOwnHomeyDeviceId(api);
      const targetLog = ownHomeyDeviceId ? allLogs.find((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(ownHomeyDeviceId) && logId.endsWith(':measure_power.home');
      }) : null;

      let powerEntries = [];

      // Fix 3: Extend fetch window to now (not midnight) so today's data is also
      // populated after a restart, not just data up to the previous midnight.
      const endDate = new Date(nowMs);
      const startDate = new Date(endDate.getTime() - 2 * 24 * 60 * 60 * 1000);

      if (targetLog) {
        try {
          const logs = await api.insights.getLogEntries({
            id: targetLog.id,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: 'yesterday', // 5 minute resolution
          });

          if (logs && logs.values && logs.values.length > 5) {
            this.log(`Got ${logs.values.length} yesterday resolution log entries from measure_power.home Insights.`);
            powerEntries = logs.values;
          }
        } catch (err) {
          this.error('Failed to retrieve log entries for targetLog:', err);
        }
      }

      if (powerEntries.length === 0) {
        this.log('Insights log for measure_power.home is empty or missing for yesterday. Reconstructing from component logs...');
        powerEntries = await this.reconstructHomePowerHistory(api, allLogs, startDate, endDate, 'yesterday').catch((err) => {
          this.error('History reconstruction failed:', err);
          return [];
        });
      }

      if (powerEntries.length > 0) {
        // Bug 5: round timestamps to nearest 5 minutes to avoid duplicates from mixed resolution sources
        const roundTo5Min = (t) => Math.round(t / (5 * 60 * 1000)) * (5 * 60 * 1000);
        const historyMapped = powerEntries
          .map((e) => {
            const time = roundTo5Min(new Date(e.t).getTime());
            let power = 0;
            if (typeof e.v === 'number') power = Math.round(e.v);
            else if (typeof e.y === 'number') power = Math.round(e.y);
            return { time, power };
          })
          .filter((e) => e.power >= 0 && e.power <= 30000);

        if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
        const existingMap = new Map(this.powerHistory.map((e) => [roundTo5Min(e.time), e]));
        historyMapped.forEach((entry) => {
          existingMap.set(entry.time, entry);
        });

        this.powerHistory = Array.from(existingMap.values());
        this.powerHistory.sort((a, b) => a.time - b.time);
        if (this.powerHistory.length > 576) this.powerHistory = this.powerHistory.slice(-576);
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.lastPowerHistorySaveTm = Date.now();
        this.log(`Merged ${historyMapped.length} historical entries into powerHistory. Total length: ${this.powerHistory.length}`);
        await this.updateForecastDisplay(true);
      }
    } catch (err) {
      this.error('Error populating power history:', err);
    }
  }

  async reconstructHomePowerHistory(api, allLogs, customStart = null, customEnd = null, customResolution = null) {
    const endDate = customEnd || new Date();
    const startDate = customStart || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 14);
      return d;
    })();
    const resolution = customResolution || 'last14Days';

    const getLogEntriesForDevice = async (deviceId, endings) => {
      const deviceLogs = allLogs.filter((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(deviceId) && !logId.includes('PH_');
      });

      const matchingLogsMap = new Map();

      deviceLogs.forEach((log) => {
        const logId = log.id || log.uri || '';
        // Find the index of the first ending that matches this log
        const matchIndex = endings.findIndex((ending) => logId.endsWith(ending));
        if (matchIndex !== -1) {
          matchingLogsMap.set(logId, { log, priority: matchIndex, isCumulative: logId.includes(':meter_power') });
        }
      });

      if (matchingLogsMap.size === 0) return null;

      // Deduplication:
      // If we are looking for cumulative totals, and we found the absolute total (e.g., ':meter_power'),
      // we must discard sub-totals (like '.t1' or '.imported') to prevent double counting.
      // But if we found phase meters ('.l1', '.l2', '.l3') or tariff meters ('.t1', '.t2'), we want to sum them.
      let finalLogs = Array.from(matchingLogsMap.values());
      const hasBaseMeterPower = finalLogs.some((item) => (item.log.id || item.log.uri || '').endsWith(':meter_power'));
      const hasBaseMeasurePower = finalLogs.some((item) => (item.log.id || item.log.uri || '').endsWith(':measure_power'));

      if (hasBaseMeterPower) {
        // If we have the grand total cumulative meter, filter out sub-tariffs and imported variants
        finalLogs = finalLogs.filter((item) => {
          const id = item.log.id || item.log.uri || '';
          return id.endsWith(':meter_power') || id.endsWith(':meter_power.exported');
        });
      }

      if (hasBaseMeasurePower) {
        // If we have the grand total instantaneous meter, filter out phase variants
        finalLogs = finalLogs.filter((item) => {
          const id = item.log.id || item.log.uri || '';
          return id.endsWith(':measure_power') || id.endsWith(':measure_power.exported');
        });
      }

      try {
        const allEntries = [];
        for (let i = 0; i < finalLogs.length; i++) {
          const { log, isCumulative } = finalLogs[i];

          const logData = await api.insights.getLogEntries({
            id: log.id,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution,
          }).catch(() => null);

          if (logData && logData.values && logData.values.length > 0) {
            let { values } = logData;
            if (isCumulative) {
              values = this.convertCumulativeToPower(values);
            }
            allEntries.push(...values.map((e) => ({
              t: new Date(e.t).getTime(),
              v: e.y !== undefined ? e.y : e.v,
            })));
          }
        }

        if (allEntries.length > 0) {
          // Group by timestamp and sum values (e.g. sum tariff 1 and tariff 2)
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

    // 1. Fetch grid entries. Try real-time power first, otherwise cumulative import & export.
    // On devices with Homey energy-class registration (which smart meters can have), the Insights
    // log for 'measure_power' itself is sometimes filed under the internal log id 'energy_power'
    // instead (same signal, different log name - see getLogEntriesForDevice's dedup below, which
    // already prefers a literal ':measure_power' log over ':energy_power' when both exist).
    let gridEntries = [];
    const measurePowerEntries = await getLogEntriesForDevice(sourceDevice.id, [
      ':measure_power', ':energy_power',
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

    // Temporary diagnostic to prove what the Insights API actually returned to us
    const activeEntries = gridEntries.length > 0 ? gridEntries : importPowerEntries;
    const dataSource = gridEntries.length > 0 ? 'measure_power (Instant)' : 'meter_power (Cumulative kWh)';
    const lowEntries = activeEntries.filter((e) => e.v < 300);

    // Find what logs ACTUALLY exist for the SmartMeter
    const deviceLogs = allLogs.filter((log) => (log.id || log.uri || '').includes(sourceDevice.id));
    const deviceLogUris = deviceLogs.map((l) => l.id || l.uri);

    this.log(`[API Diagnostic] SmartMeter Device ID: ${sourceDevice.id}`);
    this.log(`[API Diagnostic] Available Insights Logs for SmartMeter: ${JSON.stringify(deviceLogUris)}`);
    this.log(`[API Diagnostic] PBTH is using Data Source: ${dataSource}`);
    this.log(`[API Diagnostic] The API returned ${activeEntries.length} total samples (last14Days resolution).`);
    this.log(`[API Diagnostic] Number of samples below 300W returned by the API: ${lowEntries.length}`);
    if (activeEntries.length > 0) {
      const lowestRawValue = Math.min(...activeEntries.map((e) => e.v));
      this.log(`[API Diagnostic] The ABSOLUTE LOWEST raw SmartMeter value the API sent us was: ${lowestRawValue}W`);
    }

    if (gridEntries.length === 0 && importPowerEntries.length === 0) {
      this.log('No grid power entries or cumulative meter logs found. Cannot reconstruct.');
      return [];
    }

    // Bug 6: For each component driver, prefer instantaneous power (measure_power / measure_watt_avg)
    // over cumulative meter (meter_power) to avoid mixing Watts with converted-kWh Watts.
    // Only fall back to meter_power if no measure_power log exists for that device.
    // Component devices are other powerhour devices: getData().id is their synthetic pairing id,
    // not the real Homey UUID that Insights log ids use, so it must be resolved first.
    const homeyIdMap = await this.resolveHomeyDeviceIdMap(api);

    const solarEntriesList = [];
    const solarDriver = this.homey.drivers.getDriver('solar');
    if (solarDriver) {
      for (const dev of solarDriver.getDevices()) {
        const devId = homeyIdMap.get(dev.getData().id);
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':measure_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) solarEntriesList.push(entries);
      }
    }

    const batteryEntriesList = [];
    const batDriver = this.homey.drivers.getDriver('battery');
    if (batDriver) {
      for (const dev of batDriver.getDevices()) {
        const devId = homeyIdMap.get(dev.getData().id);
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':measure_watt_avg', ':measure_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) batteryEntriesList.push(entries);
      }
    }

    const evEntriesList = [];
    const evDriver = this.homey.drivers.getDriver('evCharger');
    if (evDriver) {
      for (const dev of evDriver.getDevices()) {
        const devId = homeyIdMap.get(dev.getData().id);
        if (!devId) continue;
        let entries = await getLogEntriesForDevice(devId, [
          ':measure_watt_avg', ':measure_power',
        ]);
        if (!entries || entries.length === 0) entries = await getLogEntriesForDevice(devId, [':meter_power']);
        if (entries && entries.length > 0) evEntriesList.push(entries);
      }
    }

    const timeIndex = {};
    const roundTo15Mins = (t) => Math.round(new Date(t).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);

    const addEntries = (entries, type) => {
      entries.forEach((e) => {
        const key = roundTo15Mins(e.t);
        if (!timeIndex[key]) {
          timeIndex[key] = {
            gridImport: [], gridExport: [], solar: [], battery: [], ev: [],
          };
        }
        const val = e.v !== undefined ? e.v : e.y;
        timeIndex[key][type].push(val);
      });
    };

    if (gridEntries.length > 0) {
      addEntries(gridEntries, 'gridImport');
      // If measure_power is always positive (non-negative) and we have export entries, add them to gridExport
      const hasNegative = gridEntries.some((e) => (e.y !== undefined ? e.y : e.v) < -1);
      if (!hasNegative && measurePowerExportEntries && measurePowerExportEntries.length > 0) {
        addEntries(measurePowerExportEntries, 'gridExport');
      }
    } else {
      addEntries(importPowerEntries, 'gridImport');
      addEntries(exportPowerEntries, 'gridExport');
    }

    solarEntriesList.forEach((list) => addEntries(list, 'solar'));
    batteryEntriesList.forEach((list) => addEntries(list, 'battery'));
    evEntriesList.forEach((list) => addEntries(list, 'ev'));

    const reconstructed = [];
    const timestamps = Object.keys(timeIndex).map(Number).sort((a, b) => a - b);

    timestamps.forEach((t) => {
      const data = timeIndex[t];
      if (data.gridImport.length === 0) return;

      const gridImport = data.gridImport.reduce((a, b) => a + b, 0) / data.gridImport.length;
      const gridExport = data.gridExport.length > 0 ? data.gridExport.reduce((a, b) => a + b, 0) / data.gridExport.length : 0;
      const gridPower = gridImport - gridExport;

      const solarPower = data.solar.length > 0 ? data.solar.reduce((a, b) => a + b, 0) / data.solar.length : 0;
      const batteryPower = data.battery.length > 0 ? data.battery.reduce((a, b) => a + b, 0) / data.battery.length : 0;
      const evPower = data.ev.length > 0 ? data.ev.reduce((a, b) => a + b, 0) / data.ev.length : 0;

      const homePower = gridPower + solarPower - batteryPower - evPower;

      reconstructed.push({
        t: new Date(t).toISOString(),
        y: Math.max(0, Math.min(30000, Math.round(homePower))),
      });
    });

    this.log(`Successfully reconstructed ${reconstructed.length} home power entries from component history.`);
    return reconstructed;
  }

  convertCumulativeToPower(entries) {
    const powerEntries = [];
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1];
      const curr = entries[i];
      const prevVal = prev.y !== undefined ? prev.y : prev.v;
      const currVal = curr.y !== undefined ? curr.y : curr.v;

      if (typeof prevVal !== 'number' || typeof currVal !== 'number') continue;

      const t1 = new Date(prev.t).getTime();
      const t2 = new Date(curr.t).getTime();
      const dt = (t2 - t1) / 3600000;

      if (dt > 0.01 && dt < 24) {
        const dE = currVal - prevVal;
        if (dE >= -0.0001) {
          const safeDE = Math.max(0, dE);
          const power = (safeDE / dt) * 1000;
          if (power >= 0 && power <= 30000) {
            // Emit continuous samples every 5 minutes across the cumulative gap
            // to prevent 15-minute slots from being left empty and dropping to 0W.
            const stepMs = 5 * 60 * 1000;
            const steps = Math.max(1, Math.floor((t2 - t1) / stepMs));
            for (let j = 1; j <= steps; j++) {
              const fraction = j / (steps + 1);
              const tStep = new Date(t1 + (t2 - t1) * fraction).getTime();
              powerEntries.push({ t: tStep, y: power });
            }
          }
        }
      }
    }
    return powerEntries;
  }

  destroyListeners() {
    super.destroyListeners();
    if (this.retrainLoadListener) {
      this.retrainLoadListener.destroy();
      this.retrainLoadListener = null;
    }
  }

  stopPolling() {
    super.stopPolling();
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
  }
}

module.exports = GridDevice;
