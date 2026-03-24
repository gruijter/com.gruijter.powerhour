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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const { getSolarChart, getDistributionChart } = require('../../lib/charts/SolarChart');
const OpenMeteo = require('../../lib/providers/OpenMeteo');
const SolarLearningStrategy = require('../../lib/strategies/SolarLearningStrategy');
const SolarFlows = require('../../lib/flows/SolarFlows');

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
    meter_source: 'meter_power',
    measure_source: 'measure_power', // Updated to use measure_power directly
  },
};

// Helper to convert cumulative energy (kWh) to average power (W)
const convertCumulativeToPower = (entries) => {
  const powerEntries = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    const prevVal = prev.y !== undefined ? prev.y : prev.v;
    const currVal = curr.y !== undefined ? curr.y : curr.v;

    if (typeof prevVal !== 'number' || typeof currVal !== 'number') continue;

    const t1 = new Date(prev.t).getTime();
    const t2 = new Date(curr.t).getTime();
    const dt = (t2 - t1) / 3600000; // hours

    if (dt > 0.01 && dt < 24) { // ignore tiny or huge gaps
      const dE = currVal - prevVal; // Energy diff (kWh)
      if (dE >= -0.0001) { // ignore resets, but allow small float noise
        const safeDE = Math.max(0, dE);
        const power = (safeDE / dt) * 1000; // kWh -> W
        // Use midpoint timestamp for better alignment with radiation
        const tMid = new Date(t1 + (t2 - t1) / 2).toISOString();
        powerEntries.push({ t: tMid, y: power });
      }
    }
  }
  return powerEntries;
};

class SolarDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
    this.flows = new SolarFlows(this);

    // Initialize alarm_power
    if (this.hasCapability('alarm_power') && this.getCapabilityValue('alarm_power') === null) {
      await this.setCapabilityValue('alarm_power', false).catch(this.error);
    }

    this.retrainListener = this.registerCapabilityListener('button.retrain', async () => {
      await this.retrainSolarModel(true); // Manual trigger: Retrain from scratch
      return true;
    });

    // Initialize solar specific properties
    const storedYieldFactors = await this.getStoreValue('yieldFactors');
    this.yieldFactors = storedYieldFactors || new Array(96).fill(0);
    this.forecastData = await this.getStoreValue('forecastData') || {}; // { time: radiation }
    this.forecastHistory = await this.getStoreValue('forecastHistory') || { today: null, yesterday: null };
    this.globalMaxYF = await this.getStoreValue('globalMaxYF') || 0;
    this.lastAutoRetrain = await this.getStoreValue('lastAutoRetrain') || 0;
    this.lastSolarTriggerSlot = -1;

    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    this.powerHistory = history
      .filter((e) => e && typeof e.time === 'number' && typeof e.power === 'number')
      .slice(-5000);
    if (this.powerHistory.length !== history.length) await this.setStoreValue('powerHistory', this.powerHistory);

    // Start loops
    this.startForecastLoop();
    // Delay learning loop to allow source device to settle/update
    if (this.initLearningTimeout) this.homey.clearTimeout(this.initLearningTimeout);
    this.initLearningTimeout = this.homey.setTimeout(async () => {
      // Ensure we have history for the graph (e.g. after app update)
      await this.populatePowerHistory();
      this.startLearningLoop();
      if (!storedYieldFactors) {
        this.log('First initialization: Auto-starting model retraining...');
        await this.retrainSolarModel(true); // First run: Start fresh
      }
      this.initLearningTimeout = null;
    }, 15000);
  }

  shouldUpdateCurrencyOnAdd() {
    return true;
  }

  async onSettings(opts) {
    if (opts.changedKeys.includes('export_tariff_update_group')) {
      if (typeof this.driver.updateDeviceTariff === 'function') {
        this.driver.updateDeviceTariff(this);
      }
    }
    if (super.onSettings) {
      return super.onSettings(opts);
    }
    return Promise.resolve(true);
  }

  async updateGridTariffs(currentTm) {
    try {
      if (!this.migrated || !this.tariffHistory) return;

      const s = this.getSettings();
      const purchaseGroup = s.tariff_update_group;
      const exportGroup = s.export_tariff_update_group || 0;

      const driverTariffs = this.driver.tariffs || {};
      let purchaseTariff = driverTariffs[purchaseGroup];
      if (purchaseTariff === undefined) purchaseTariff = this.tariffHistory.current;

      let exportTariff = driverTariffs[exportGroup];
      if (exportGroup === 0 || exportTariff === undefined) exportTariff = purchaseTariff;

      const tariffHistory = {
        previous: this.tariffHistory.current,
        previousExport: this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : this.tariffHistory.current,
        previousTm: this.tariffHistory.currentTm,
        current: purchaseTariff,
        currentExport: exportTariff,
        currentTm,
      };

      this.tariffHistory = tariffHistory;
      await this.setCapability('meter_tariff', purchaseTariff).catch(this.error);
      this.setSettings({ tariff: purchaseTariff }).catch(this.error);
      await this.setStoreValue('tariffHistory', tariffHistory);
    } catch (error) {
      this.error(error);
    }
  }

  async updateMoney({ ...reading }, { ...periods }) {
    let tariff = this.tariffHistory.current;
    let exportTariff = this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : tariff;

    if (tariff !== this.getCapabilityValue('meter_tariff')) {
      await this.setCapability('meter_tariff', tariff).catch(this.error);
    }

    // Use previous hour tariff just after newHour if previous tariff is less than an hour old
    if (periods.newHour && this.tariffHistory && this.tariffHistory.previousTm
      && (new Date(reading.meterTm) - new Date(this.tariffHistory.previousTm))
      < (61 + (this.getSettings().wait_for_update || 0)) * 60 * 1000) {
      tariff = this.tariffHistory.previous;
      exportTariff = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : tariff;
    }

    // Decide which tariff to use based on live grid power
    let activeTariff = tariff;
    if (typeof this.currentGridPower === 'number') {
      activeTariff = this.currentGridPower < 0 ? exportTariff : tariff;
    }

    // Calculate money
    const deltaMoney = (reading.meterValue - this.meterMoney.meterValue) * activeTariff;
    const meterMoney = {
      hour: this.meterMoney.hour + deltaMoney,
      day: this.meterMoney.day + deltaMoney,
      month: this.meterMoney.month + deltaMoney,
      year: this.meterMoney.year + deltaMoney,
      meterValue: reading.meterValue,
      lastHour: this.meterMoney.lastHour,
      lastDay: this.meterMoney.lastDay,
      lastMonth: this.meterMoney.lastMonth,
      lastYear: this.meterMoney.lastYear,
    };

    let fixedMarkup = 0;
    if (periods.newHour) {
      meterMoney.lastHour = meterMoney.hour;
      meterMoney.hour = 0;
      fixedMarkup += (this.getSettings().markup_hour || 0);
      await this.setCapability('meter_money_last_hour', meterMoney.lastHour);
      await this.setSettings({ meter_money_last_hour: meterMoney.lastHour }).catch(this.error);
    }
    if (periods.newDay) {
      meterMoney.lastDay = meterMoney.day;
      meterMoney.day = 0;
      fixedMarkup += (this.getSettings().markup_day || 0);
      await this.setCapability('meter_money_last_day', meterMoney.lastDay);
      await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch(this.error);
    }
    if (periods.newMonth) {
      meterMoney.lastMonth = meterMoney.month;
      meterMoney.month = 0;
      fixedMarkup += (this.getSettings().markup_month || 0);
      await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
      await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch(this.error);
    }
    if (periods.newYear) {
      meterMoney.lastYear = meterMoney.year;
      meterMoney.year = 0;
      await this.setCapability('meter_money_last_year', meterMoney.lastYear);
      await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch(this.error);
    }

    // add fixed markups
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;

    // update money_this_x capabilities
    await this.setCapability('meter_money_this_hour', meterMoney.hour);
    await this.setCapability('meter_money_this_day', meterMoney.day);
    await this.setCapability('meter_money_this_month', meterMoney.month);
    await this.setCapability('meter_money_this_year', meterMoney.year);
    this.meterMoney = meterMoney;

    // Update settings every hour
    if (periods.newHour) {
      await this.setSettings({ meter_money_this_day: meterMoney.day }).catch(this.error);
      await this.setSettings({ meter_money_this_month: meterMoney.month }).catch(this.error);
      await this.setSettings({ meter_money_this_year: meterMoney.year }).catch(this.error);
    }
  }

  // --- Solar Logic ---

  async startForecastLoop() {
    // Fetch forecast every hour
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        await this.fetchForecast();

        // Automatic nightly retrain (at 01:00) to maintain model stability.
        // This ensures the "Batch" part of the hybrid model actually happens,
        // correcting drift and seasonal changes without user intervention.
        const now = new Date();
        if (now.getHours() === 1) {
          const lastRun = new Date(this.lastAutoRetrain);
          const isSameDay = lastRun.getDate() === now.getDate() && lastRun.getMonth() === now.getMonth() && lastRun.getFullYear() === now.getFullYear();

          if (!isSameDay) {
            this.log('Running automatic nightly solar model retraining...');
            await this.retrainSolarModel(false); // Nightly: Blend with existing data
            this.lastAutoRetrain = now.getTime();
            await this.setStoreValue('lastAutoRetrain', this.lastAutoRetrain);
          }
        }
      } catch (err) {
        this.error('Forecast fetch failed:', err);
      } finally {
        if (!this.isDestroyed) {
          this.forecastTimeout = this.homey.setTimeout(loop, 60 * 60 * 1000); // 1 hour
        }
      }
    };
    await loop();
  }

  async startLearningLoop() {
    // Update learning loop runs every 1 min.
    // We run this frequently to:
    // 1. Collect power samples for accurate averaging (essential for devices without energy meters).
    // 2. Detect curtailment events in near real-time.
    // 3. Update the real-time forecast capability (measure_watt_forecast.h0).
    // Note: The actual model retraining (getStrategy) only occurs once per 15-minute slot when a bucket finishes.
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        const updated = await this.updateLearning();
        await this.updateForecastDisplay(updated);
      } catch (err) {
        this.error('Learning update failed:', err);
      } finally {
        if (!this.isDestroyed) {
          // Align to next 1 min slot
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

  async fetchForecast() {
    let { lat, lon } = this.getSettings();

    // Fallback to Homey location if not set in settings
    if (!lat || !lon) {
      lat = this.homey.geolocation.getLatitude();
      lon = this.homey.geolocation.getLongitude();
    }

    if (!lat || !lon) {
      this.log('Missing Latitude/Longitude for forecast');
      return;
    }

    const data = await OpenMeteo.fetchForecast(lat, lon);
    if (data && Object.keys(data).length > 0) {
      // Apply Time Shift
      const timeShift = this.getSettings().solar_time_shift || 0;
      if (timeShift !== 0) {
        const shiftedData = {};
        Object.keys(data).forEach((t) => {
          const newTime = Number(t) + (timeShift * 3600000);
          shiftedData[newTime] = data[t];
        });
        this.forecastData = shiftedData;
      } else {
        this.forecastData = data;
      }

      await this.setStoreValue('forecastData', this.forecastData);
      this.log('Forecast updated');
      this.forecastChanged = true;
    }
  }

  async updateLearning() {
    let updated = false;
    const now = new Date();
    const currentTimestamp = now.getTime();

    // Get current power (W)
    const rawPower = this.getCapabilityValue('measure_power');
    const currentEnergy = this.getCapabilityValue('meter_power');

    // 1. Smooth Power
    const { smoothedPower, newEnergyState } = SolarLearningStrategy.calculateSmoothedPower({
      currentPower: rawPower,
      currentEnergy,
      lastEnergyState: this.lastEnergyState,
      currentTimestamp,
    });
    this.lastEnergyState = newEnergyState;
    const currentPower = smoothedPower;

    // 2. Record History & Detect Curtailment
    if (typeof currentPower === 'number') {
      const lastEntry = this.powerHistory[this.powerHistory.length - 1];
      if (!lastEntry || (currentTimestamp - lastEntry.time) > 50000) {
        this.powerHistory.push({ time: currentTimestamp, power: currentPower });
        if (this.powerHistory.length > 5000) this.powerHistory.shift();
        await this.setStoreValue('powerHistory', this.powerHistory);

        const curtailment = SolarLearningStrategy.detectCurtailment({
          currentPower,
          lastPower: lastEntry ? lastEntry.power : 0,
          forecastData: this.forecastData,
          yieldFactors: this.yieldFactors,
          isCurtailmentActive: this.getCapabilityValue('alarm_power'),
          timestamp: now,
        });

        if (curtailment.changed) {
          await this.setCapabilityValue('alarm_power', curtailment.isActive).catch(this.error);
          if (curtailment.log) this.log(curtailment.log);

          // Trigger explicit curtailment flow cards
          if (curtailment.isActive && this.homey.app.trigger_solar_curtailment_active) {
            this.homey.app.trigger_solar_curtailment_active(this, {}, {}).catch(this.error);
          } else if (!curtailment.isActive && this.homey.app.trigger_solar_curtailment_inactive) {
            this.homey.app.trigger_solar_curtailment_inactive(this, {}, {}).catch(this.error);
          }
        }
      }
    }

    // 3. Bucket Learning
    const currentSlotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
    const bucketResult = SolarLearningStrategy.processBucket({
      bucket: this.learningBucket,
      currentSlotIndex,
      currentTimestamp,
      currentPower,
      currentEnergy,
    });

    this.learningBucket = bucketResult.bucket;

    if (bucketResult.finishedBucket) {
      if (bucketResult.finishedBucket.log) this.log(bucketResult.finishedBucket.log);

      if (this.getCapabilityValue('alarm_power')) {
        this.log('Curtailment active, skipping learning for this bucket');
      } else {
        const result = SolarLearningStrategy.getStrategy({
          currentPower: bucketResult.finishedBucket.avgPower,
          forecastData: this.forecastData,
          yieldFactors: this.yieldFactors,
          timestamp: new Date(bucketResult.finishedBucket.startTime),
          globalMaxYF: this.globalMaxYF,
        });
        if (result.updated) {
          this.yieldFactors = result.yieldFactors;
          await this.setStoreValue('yieldFactors', this.yieldFactors);
          this.log(result.log);
          updated = true;
        }
      }
    }
    return updated;
  }

  async retrainSolarModel(fromScratch = false) {
    this.log(`Starting solar model retraining... (Mode: ${fromScratch ? 'From Scratch' : 'Blend'})`);
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) {
        // ignore
      }
      if (!api) throw new Error('Homey API not ready');

      const sourceDevice = await this.getSourceDevice();
      if (!sourceDevice) throw new Error('No source device found');
      this.log('Source Device ID:', sourceDevice.id);

      // 1. Fetch Weather History (14 days) - needed for both steps
      const endDate = new Date();
      const startDate14 = new Date();
      startDate14.setDate(startDate14.getDate() - 14);

      let { lat, lon } = this.getSettings();
      if (!lat || !lon) {
        lat = this.homey.geolocation.getLatitude();
        lon = this.homey.geolocation.getLongitude();
      }
      if (!lat || !lon) throw new Error('Location not set');

      // Ensure inputs are numbers for accurate processing
      lat = Number(lat);
      lon = Number(lon);

      this.log(`Fetching weather history from ${startDate14.toISOString()}`);
      const weatherHistory = await OpenMeteo.fetchHistoric(lat, lon, startDate14, endDate);
      if (!weatherHistory || weatherHistory.length === 0) {
        throw new Error('No historic weather data found');
      }
      this.log(`Got ${weatherHistory.length} weather samples`);

      // Apply Time Shift
      const timeShift = this.getSettings().solar_time_shift || 0;
      if (timeShift !== 0) {
        this.log(`Applying time shift of ${timeShift} hours to weather data`);
        weatherHistory.forEach((w) => {
          w.time += timeShift * 3600000;
        });
      }

      // Update forecastData with the fresh (and potentially shifted) weather data
      const freshForecast = {};
      weatherHistory.forEach((e) => {
        freshForecast[e.time] = e.radiation;
      });
      this.forecastData = { ...this.forecastData, ...freshForecast };
      await this.setStoreValue('forecastData', this.forecastData);
      this.forecastChanged = true;

      // 2. Locate Insights Log
      let allLogs = await api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const deviceLogs = allLogs.filter((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(sourceDevice.id) && !logId.includes('PH_');
      });
      const availableCaps = deviceLogs.map((l) => (l.id || l.uri || '').split(':').pop()).join(', ');
      this.log(`Available Insight logs for ${sourceDevice.name}: ${availableCaps}`);

      const candidates = [
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':energy_power')),
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':meter_power')),
      ].filter(Boolean);

      let targetLog = null;
      for (const candidate of candidates) {
        const testLogs = await api.insights.getLogEntries({
          id: candidate.id,
          start: startDate14.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last14Days',
        }).catch(() => null);

        if (testLogs && testLogs.values && testLogs.values.length > 0) {
          let entries = testLogs.values;
          if ((candidate.uri || '').endsWith(':meter_power')) entries = convertCumulativeToPower(entries);
          const hasData = entries.some((e) => {
            const p = e.y !== undefined ? e.y : e.v;
            return typeof p === 'number' && p > 10;
          });
          if (hasData) {
            targetLog = candidate;
            break;
          }
        }
      }

      if (!targetLog) {
        throw new Error(`No Insights log with valid >10W data found for device ${sourceDevice.id}. Available logs: ${availableCaps || 'none'}`);
      }
      this.log(`Found target log: ${targetLog.name || 'unknown'} (ID: ${targetLog.id})`);

      const isCumulative = targetLog.uri.endsWith(':meter_power');
      if (isCumulative) this.log('Using cumulative energy log (converting to power)...');

      // Initialize fresh yield factors for training to remove old artifacts
      // Use null to safely identify missing data vs valid 0-yield shading
      let trainingYieldFactors = new Array(96).fill(null);
      let physicalLimit = 0;

      // 3. Step 1: Coarse Learning (14 days, hourly)
      this.log('Step 1: Coarse learning (14 days, hourly)');
      let step1Accumulators = null;
      try {
        const logs14 = await api.insights.getLogEntries({
          id: targetLog.id,
          start: startDate14.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last14Days',
        });

        if (logs14 && logs14.values && logs14.values.length > 50) {
          // Filter out the last 24 hours from coarse data to avoid double counting
          // (Step 2 will cover the last 24h with higher resolution)
          const cutoffTime = new Date();
          cutoffTime.setDate(cutoffTime.getDate() - 1);
          let powerEntries = logs14.values.filter((e) => new Date(e.t) < cutoffTime);

          if (isCumulative) {
            powerEntries = convertCumulativeToPower(powerEntries);
          }

          // Populate powerHistory from coarse data
          const history = powerEntries.map((e) => ({
            time: new Date(e.t).getTime(),
            power: e.y !== undefined ? e.y : e.v,
          })).filter((e) => typeof e.power === 'number');
          this.powerHistory = history;

          const result1 = SolarLearningStrategy.processHistoricData({
            powerEntries,
            weatherEntries: weatherHistory,
            currentYieldFactors: trainingYieldFactors,
            resolution: 'hourly',
            logger: (msg) => this.log(msg),
          });
          if (result1.updated) {
            trainingYieldFactors = result1.yieldFactors;
            step1Accumulators = result1.slotAccumulators;
            physicalLimit = result1.limit; // Capture the robust Power-based limit
            this.log(`Step 1 complete: ${result1.log}`);
          } else {
            this.log(`Step 1: ${result1.log}`);
          }
        } else {
          this.log('Step 1 skipped: Insufficient hourly data.');
        }
      } catch (e) {
        this.error('Step 1 failed:', e);
      }

      // 4. Step 2: Fine Tuning (24 hours, 5m)
      this.log('Step 2: Fine tuning (24 hours, 5m)');
      try {
        const startDate24h = new Date();
        startDate24h.setDate(startDate24h.getDate() - 1);

        const logs24h = await api.insights.getLogEntries({
          id: targetLog.id,
          start: startDate24h.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last24Hours',
        });

        if (logs24h && logs24h.values && logs24h.values.length > 50) {
          let powerEntries = logs24h.values;
          if (isCumulative) {
            powerEntries = convertCumulativeToPower(powerEntries);
          }

          // Merge fine data into powerHistory
          const recentHistory = powerEntries.map((e) => ({
            time: new Date(e.t).getTime(),
            power: e.y !== undefined ? e.y : e.v,
          })).filter((e) => typeof e.power === 'number');

          if (recentHistory.length > 0) {
            const minRecentTime = recentHistory[0].time;
            this.powerHistory = this.powerHistory.filter((e) => e.time < minRecentTime);
            this.powerHistory = this.powerHistory.concat(recentHistory);
          }
          this.powerHistory.sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 5000) this.powerHistory = this.powerHistory.slice(-5000);
          await this.setStoreValue('powerHistory', this.powerHistory);

          const result2 = SolarLearningStrategy.processHistoricData({
            powerEntries,
            weatherEntries: weatherHistory,
            currentYieldFactors: trainingYieldFactors,
            previousAccumulators: step1Accumulators,
            resolution: 'high',
            maxYieldFactorLimit: physicalLimit, // Enforce the robust limit found in Step 1
            logger: (msg) => this.log(msg),
          });
          if (result2.updated) {
            trainingYieldFactors = result2.yieldFactors;
            this.log(`Step 2 complete: ${result2.log}`);
          } else {
            this.log(`Step 2: ${result2.log}`);
          }
        } else {
          this.log('Step 2 skipped: Insufficient high-res data.');
        }
      } catch (e) {
        this.error('Step 2 failed:', e);
      }

      // 5. Save and Update
      const mergeResult = SolarLearningStrategy.mergeYields({
        historicYields: trainingYieldFactors,
        liveYields: fromScratch ? new Array(96).fill(0) : this.yieldFactors, // Ignore live data if scratch
        alpha: fromScratch ? 1.0 : 0.7, // 100% historic if scratch, else 70% weight
        limit: physicalLimit, // Enforce the physical limit found in Step 1
      });
      this.yieldFactors = mergeResult.yieldFactors;
      this.log(mergeResult.log);

      // Recalculate and store the global max from the new model
      this.globalMaxYF = Math.max(0, ...this.yieldFactors);
      await this.setStoreValue('globalMaxYF', this.globalMaxYF);
      this.log(`New Global Max Yield Factor: ${this.globalMaxYF.toFixed(2)} (Est. Wpeak: ~${Math.round(this.globalMaxYF * 1000)}W)`);

      await this.setStoreValue('yieldFactors', this.yieldFactors);
      await this.updateForecastDisplay(true);
      this.log('Retraining finished.');
    } catch (err) {
      this.error('Retraining failed:', err);
    }
  }

  async populatePowerHistory() {
    try {
      const now = Date.now();

      // Check if we have sufficient history (at least 24h worth of data)
      // Need ~40 hours to cover yesterday morning from today evening
      const hasData = this.powerHistory.length > 24 && this.powerHistory[0].time < (now - 40 * 60 * 60 * 1000);
      const hasRecent = this.powerHistory.length > 0 && this.powerHistory[this.powerHistory.length - 1].time > (now - 6 * 60 * 60 * 1000);

      if (hasData && hasRecent) {
        return;
      }

      this.log('[populatePowerHistory] Populating power history from Insights...');

      let api;
      try {
        api = this.homey.app.api;
      } catch (e) { }
      if (!api) {
        this.log('[populatePowerHistory] Homey API not ready');
        return;
      }

      const sourceDevice = await this.getSourceDevice();
      if (!sourceDevice) {
        this.log('[populatePowerHistory] No source device');
        return;
      }

      // Locate Insights Log
      let allLogs = await api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const deviceLogs = allLogs.filter((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(sourceDevice.id) && !logId.includes('PH_');
      });

      const candidates = [
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':energy_power')),
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':meter_power')),
      ].filter(Boolean);

      let targetLog = candidates[0]; // Default to first if none have data
      for (const candidate of candidates) {
        const testLogs = await api.insights.getLogEntries({
          id: candidate.id,
          resolution: 'last14Days',
        }).catch(() => null);

        if (testLogs && testLogs.values && testLogs.values.length > 0) {
          let entries = testLogs.values;
          if ((candidate.uri || '').endsWith(':meter_power')) entries = convertCumulativeToPower(entries);
          const hasData = entries.some((e) => {
            const p = e.y !== undefined ? e.y : e.v;
            return typeof p === 'number' && p > 10;
          });
          if (hasData) {
            targetLog = candidate;
            break;
          }
        }
      }

      if (!targetLog) {
        this.log('[populatePowerHistory] No target log found');
        return;
      }

      const isCumulative = targetLog.uri.endsWith(':meter_power');

      // Fetch last 2 days ending at start of today (to avoid overwriting today's realtime data)
      let endDate = new Date();
      try {
        const now = new Date();
        const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
        const offset = nowLocal.getTime() - now.getTime();
        const midnightLocal = new Date(nowLocal);
        midnightLocal.setHours(0, 0, 0, 0);
        endDate = new Date(midnightLocal.getTime() - offset);
      } catch (e) { }

      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 2);

      this.log(`[populatePowerHistory] Fetching logs for ${targetLog.uri} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

      const logs = await api.insights.getLogEntries({
        id: targetLog.id,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        resolution: 'yesterday', // 5 minute resolution
      });

      if (logs && logs.values && logs.values.length > 0) {
        this.log(`[populatePowerHistory] Got ${logs.values.length} entries`);
        let entries = logs.values;
        if (isCumulative) {
          entries = convertCumulativeToPower(entries);
        }

        const newHistory = entries.map((e) => ({
          time: new Date(e.t).getTime(),
          power: e.y !== undefined ? e.y : e.v,
        })).filter((e) => typeof e.power === 'number');

        // Merge with existing history
        const existingMap = new Map(this.powerHistory.map((e) => [e.time, e]));
        newHistory.forEach((e) => existingMap.set(e.time, e));

        this.powerHistory = Array.from(existingMap.values())
          .sort((a, b) => a.time - b.time)
          .slice(-5000);

        await this.setStoreValue('powerHistory', this.powerHistory);
        this.log(`[populatePowerHistory] Populated power history. New length: ${this.powerHistory.length}`);
        await this.updateForecastDisplay(true);
      } else {
        this.log('[populatePowerHistory] No entries received from Insights');
      }
    } catch (err) {
      this.error('[populatePowerHistory] Error:', err);
    }
  }

  async updateForecastDisplay(yieldFactorsUpdated = false) {
    const now = new Date();
    let dayChanged = false;

    // --- 0. Manage Forecast History (For Fixed Yesterday Chart) ---
    const nowLocalStr = now.toLocaleDateString('en-CA', { timeZone: this.timeZone }); // YYYY-MM-DD

    // Calculate Today's Power Series (Forecast) to cache
    const todayMidnight = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
    todayMidnight.setHours(0, 0, 0, 0);
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);

    const todaySeries = {};
    // Iterate 15 min slots for the full local day
    for (let t = todayMidnight.getTime(); t < tomorrowMidnight.getTime(); t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      const slot = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
      const yf = this.yieldFactors[slot] || 0;
      todaySeries[t] = Math.round(rad * yf);
    }

    // Rotate history if day changed
    if (this.forecastHistory.today && this.forecastHistory.today.date !== nowLocalStr) {
      this.log(`[updateForecastDisplay] Rotating history. Moving ${this.forecastHistory.today.date} to Yesterday. New Today: ${nowLocalStr}`);
      this.forecastHistory.yesterday = this.forecastHistory.today;
      dayChanged = true;
    }

    // Backfill yesterday if missing (e.g. new device or after retrain)
    if (!this.forecastHistory.yesterday) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayLocalStr = yesterday.toLocaleDateString('en-CA', { timeZone: this.timeZone });

      const yesterdayMidnight = new Date(todayMidnight);
      yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
      const yesterdayEnd = new Date(yesterdayMidnight);
      yesterdayEnd.setDate(yesterdayEnd.getDate() + 1);

      // Check if we have weather data for yesterday
      const hasData = Object.keys(this.forecastData).some((t) => {
        const time = Number(t);
        return time >= yesterdayMidnight.getTime() && time < yesterdayEnd.getTime();
      });

      if (hasData) {
        this.log(`[updateForecastDisplay] Backfilling yesterday forecast for ${yesterdayLocalStr}`);
        const yesterdaySeries = {};
        for (let t = yesterdayMidnight.getTime(); t < yesterdayEnd.getTime(); t += 15 * 60 * 1000) {
          const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
          const slot = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
          const yf = this.yieldFactors[slot] || 0;
          yesterdaySeries[t] = Math.round(rad * yf);
        }
        this.forecastHistory.yesterday = { date: yesterdayLocalStr, data: yesterdaySeries };
        dayChanged = true;
      } else {
        this.log(`[updateForecastDisplay] Cannot backfill yesterday: No weather data for ${yesterdayLocalStr}`);
      }
    }

    // Update today's cache
    this.forecastHistory.today = { date: nowLocalStr, data: todaySeries };
    await this.setStoreValue('forecastHistory', this.forecastHistory);

    // --- Calculate Totals ---
    const { expectedPower, totalYield } = SolarLearningStrategy.calculateForecast({
      forecastData: this.forecastData,
      yieldFactors: this.yieldFactors,
      timestamp: now,
      timezone: this.timeZone,
    });

    const getForecast = (offsetMinutes) => {
      const t = now.getTime() + offsetMinutes * 60 * 1000;
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      const dateT = new Date(t);
      const slotIndex = (dateT.getUTCHours() * 4) + Math.floor(dateT.getUTCMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      return Math.round(rad * yf);
    };

    await this.setCapabilityValue('measure_watt_forecast.h0', expectedPower).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m15', getForecast(15)).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m30', getForecast(30)).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.m45', getForecast(45)).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h1', getForecast(60)).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h2', getForecast(120)).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.h3', getForecast(180)).catch(this.error);

    // Calculate Forecast This Hour (h0)
    let forecastH0 = 0;
    const startOfHour = new Date(now);
    startOfHour.setMinutes(0, 0, 0);
    for (let i = 0; i < 4; i += 1) {
      const t = startOfHour.getTime() + i * 15 * 60 * 1000;
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      const dateT = new Date(t);
      const slotIndex = (dateT.getUTCHours() * 4) + Math.floor(dateT.getUTCMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      const power = rad * yf; // Watts
      forecastH0 += (power * 0.25) / 1000; // kWh
    }
    await this.setCapabilityValue('meter_kwh_forecast.h0', Number(forecastH0.toFixed(2))).catch(this.error);
    await this.setCapabilityValue('meter_kwh_forecast.this_day', totalYield).catch(this.error);

    // Calculate Forecast Tomorrow
    const dayAfterTomorrowMidnight = new Date(tomorrowMidnight);
    dayAfterTomorrowMidnight.setDate(dayAfterTomorrowMidnight.getDate() + 1);
    const tomorrowStats = this.getForecastStatsBetween(tomorrowMidnight, dayAfterTomorrowMidnight);
    await this.setCapabilityValue('meter_kwh_forecast.tomorrow', tomorrowStats.totalYield).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.tomorrow_peak', tomorrowStats.peakPower).catch(this.error);

    // --- Update Charts ---

    // 1. Today
    const { start: todayStart, end: todayEnd } = SolarLearningStrategy.getSunBounds(now, this.forecastData, this.timeZone);

    const chartToday = await getSolarChart(this.forecastData, this.yieldFactors, todayStart, todayEnd, 'Forecast This Day', this.powerHistory, this.timeZone, this.globalMaxYF);
    if (chartToday) {
      this.chartSolarToday = chartToday;
      if (!this.solarTodayImage) {
        this.solarTodayImage = await this.homey.images.createImage();
        this.solarTodayImage.setStream(async (stream) => imageUrlToStream(this.chartSolarToday, stream, this));
        await this.setCameraImage('solarToday', 'Solar This Day', this.solarTodayImage);
      }
      await this.solarTodayImage.update();
    }

    // 2. Tomorrow
    if (yieldFactorsUpdated || this.forecastChanged || !this.solarTomorrowImage) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { start: tomorrowStart, end: tomorrowEnd } = SolarLearningStrategy.getSunBounds(tomorrow, this.forecastData, this.timeZone);

      const chartTomorrow = await getSolarChart(this.forecastData, this.yieldFactors, tomorrowStart, tomorrowEnd, 'Forecast Tomorrow', this.powerHistory, this.timeZone, this.globalMaxYF);
      if (chartTomorrow) {
        this.chartSolarTomorrow = chartTomorrow;
        if (!this.solarTomorrowImage) {
          this.solarTomorrowImage = await this.homey.images.createImage();
          this.solarTomorrowImage.setStream(async (stream) => imageUrlToStream(this.chartSolarTomorrow, stream, this));
          await this.setCameraImage('solarTomorrow', 'Solar Tomorrow', this.solarTomorrowImage);
        }
        await this.solarTomorrowImage.update();
      }
    }

    // 3. Yesterday (Fixed Forecast)
    if (this.forecastHistory.yesterday && (!this.solarYesterdayImage || yieldFactorsUpdated || dayChanged)) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);

      // Use the frozen power data from history to determine bounds and draw chart
      const frozenData = this.forecastHistory.yesterday.data;
      const { start: yStart, end: yEnd } = SolarLearningStrategy.getSunBounds(yesterday, frozenData, this.timeZone);

      // Pass dummy yield factors (1.0) because frozenData is already Power (W), not Radiation
      const dummyYields = new Array(96).fill(1.0);
      const chartYesterday = await getSolarChart(frozenData, dummyYields, yStart, yEnd, 'Solar Yesterday', this.powerHistory, this.timeZone, this.globalMaxYF);

      if (chartYesterday) {
        this.chartSolarYesterday = chartYesterday;
        if (!this.solarYesterdayImage) {
          this.solarYesterdayImage = await this.homey.images.createImage();
          this.solarYesterdayImage.setStream(async (stream) => imageUrlToStream(this.chartSolarYesterday, stream, this));
          await this.setCameraImage('solarYesterday', 'Solar Yesterday', this.solarYesterdayImage);
        }
        await this.solarYesterdayImage.update();
      }
    }

    // 3. Distribution
    if (yieldFactorsUpdated || !this.solarDistributionImage) {
      const chartDist = await getDistributionChart(this.yieldFactors, 'Yield Distribution', this.timeZone);
      if (chartDist) {
        this.chartSolarDistribution = chartDist;
        if (!this.solarDistributionImage) {
          this.solarDistributionImage = await this.homey.images.createImage();
          this.solarDistributionImage.setStream(async (stream) => imageUrlToStream(this.chartSolarDistribution, stream, this));
          await this.setCameraImage('solarDistribution', 'Solar Distribution', this.solarDistributionImage);
        }
        await this.solarDistributionImage.update();
      }
    }

    // 4. Trigger Solar Yield Flows at the start of a new 15 minute period
    const currentSlot = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
    if (this.lastSolarTriggerSlot !== currentSlot || yieldFactorsUpdated || this.forecastChanged) {
      this.lastSolarTriggerSlot = currentSlot;
      await this.flows.triggerSolarYieldFlows().catch((err) => this.error('Error triggering solar yield flows', err));
    }

    if (yieldFactorsUpdated || this.forecastChanged) {
      await this.flows.triggerForecastUpdated().catch((err) => this.error('Error triggering forecast updated flows', err));
    }

    this.forecastChanged = false;
  }

  getForecastRemaining(targetDateLocal) {
    const now = new Date();
    const timezone = this.timeZone || 'UTC';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    // If target is in the past relative to now, return 0
    if (targetDateLocal <= nowLocal) return 0;

    return this.getForecastBetween(nowLocal, targetDateLocal);
  }

  getForecastStatsBetween(startLocal, endLocal) {
    const now = new Date();
    const timezone = this.timeZone || 'UTC';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    // Adjust end date if it is before start (e.g. crossing midnight 22:00 -> 06:00)
    // Note: This logic assumes 'end' is the next occurance of that time relative to start.
    const adjustedEnd = new Date(endLocal);
    if (adjustedEnd < startLocal) {
      adjustedEnd.setDate(adjustedEnd.getDate() + 1);
    }

    // Convert Local Start/End to UTC timestamps
    // Simple offset calculation based on 'now'
    const offset = nowLocal.getTime() - now.getTime();
    const startTimeUTC = startLocal.getTime() - offset;
    const endTimeUTC = adjustedEnd.getTime() - offset;

    let totalYield = 0;
    let peakPower = 0;
    const startSlot = Math.ceil(startTimeUTC / (15 * 60 * 1000)) * 15 * 60 * 1000;

    for (let t = startSlot; t < endTimeUTC; t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      // Determine slot index for this specific timestamp
      // Need to convert back to local to find the correct 0-95 slot index
      // Fast approximation of local time from UTC t using the fixed offset calculated earlier
      const tLocal = new Date(t + offset);

      const slotIndex = (tLocal.getHours() * 4) + Math.floor(tLocal.getMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      const power = rad * yf; // Watts
      const roundedPower = Math.round(power);
      if (roundedPower > peakPower) peakPower = roundedPower;
      totalYield += (power * 0.25) / 1000; // kWh
    }

    return {
      totalYield: Number(totalYield.toFixed(2)),
      peakPower,
    };
  }

  getForecastBetween(startLocal, endLocal) {
    return this.getForecastStatsBetween(startLocal, endLocal).totalYield;
  }

  destroyListeners() {
    super.destroyListeners();
    if (this.retrainListener) {
      this.retrainListener.destroy();
      this.retrainListener = null;
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

  // EXECUTORS FOR ACTION FLOWS
  async runFlowAction(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Action ${id} not implemented`);
  }

  // EXECUTORS FOR CONDITION FLOWS
  async runFlowCondition(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Condition ${id} not implemented`);
  }

  // EXECUTORS FOR FLOW TRIGGERS
  async runFlowTrigger(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Trigger ${id} not implemented`);
  }

}

module.exports = SolarDevice;
