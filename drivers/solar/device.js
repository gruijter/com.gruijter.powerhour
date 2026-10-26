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
const { getSolarChart, getDistributionChart } = require('../../lib/charts/SolarChart');
const OpenMeteo = require('../../lib/providers/OpenMeteo');
const SolarEclipse = require('../../lib/helpers/SolarEclipse');
const SolarLearningStrategy = require('../../lib/strategies/SolarLearningStrategy');
const SolarFlows = require('../../lib/flows/SolarFlows');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const LoadSpread = require('../../lib/helpers/LoadSpread');
const ChartImages = require('../../lib/helpers/ChartImages');
const { fetchYesterdayAndToday, convertCumulativeToPower, mergeStoredHistory } = require('../../lib/helpers/HistoryLookup');

const BOOTSTRAP_THRESHOLD_DAYS = 14; // days of training data for the solar model

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
    measure_source: 'measure_power',
    minMaxPrefix: 'measure_watt',
  },
};

class SolarDevice extends GenericDevice {

  async initDeviceValues() {
    // Before super.initDeviceValues(), or the first poll zeroes it
    this.meterSelfConsumed = await this.getStoreValue('meterSelfConsumed') || 0;
    this.meterTotalIntegrated = await this.getStoreValue('meterTotalIntegrated') || 0;
    await super.initDeviceValues();
  }

  async onInit() {
    this.ds = deviceSpecifics;
    this.flows = new SolarFlows(this);

    // Before super.onInit(): its first poll records samples (mergeStoredHistory).
    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    const storedHistory = history.filter((e) => e && typeof e.time === 'number' && typeof e.power === 'number');
    if (storedHistory.length !== history.length) await this.setStoreValue('powerHistory', storedHistory);
    this.powerHistory = mergeStoredHistory(storedHistory, this.powerHistory, 576);

    // Before super.onInit(): it sets initReady partway, after which chart updates may run.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    await super.onInit().catch(this.error);

    // A newer onInit() may have started meanwhile: the loops below must not be started twice.
    const sessionIdAfterSuper = this.sessionId;

    if (this.hasCapability('alarm_power') && this.getCapabilityValue('alarm_power') === null) {
      await this.setCapabilityValue('alarm_power', false).catch(this.error);
    }

    // Auto-fill empty lat/lon settings at startup
    const currentSettings = this.getSettings();
    if (!currentSettings.lat || !currentSettings.lon) {
      const homeyLat = this.homey.geolocation.getLatitude();
      const homeyLon = this.homey.geolocation.getLongitude();
      if (homeyLat && homeyLon) {
        await this.setSettings({
          lat: String(homeyLat),
          lon: String(homeyLon),
        }).catch(this.error);
        this.log(`Auto-filled empty lat/lon settings with Homey location: ${homeyLat}, ${homeyLon}`);
      }
    }

    const s = this.getSettings();
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!s.lat || !s.lon || (lat === 0 && lon === 0) || Number.isNaN(lat) || Number.isNaN(lon)) {
      await this.setUnavailable(this.homey.__('error_no_location')).catch(this.error);
      return; // until a valid location is set
    }
    await this.setAvailable().catch(this.error);

    this.retrainListener = this.registerCapabilityListener('button.retrain', async () => {
      this.peakPowerAllTime = 0;
      await this.setStoreValue('peakPowerAllTime', 0);
      await this.retrainSolarModel(true); // manual: retrain from scratch
      return true;
    });

    this.exportDiagnosticsListener = this.registerCapabilityListener('button.export_diagnostics', async () => {
      await this.exportDiagnostics();
      return true;
    });

    const storedYieldFactors = await this.getStoreValue('yieldFactors');
    this.yieldFactors = storedYieldFactors || new Array(96).fill(0);
    this.forecastData = await this.getStoreValue('forecastData') || {}; // { time: radiation }
    this.forecastHistory = await this.getStoreValue('forecastHistory') || { today: null, yesterday: null };
    this.globalMaxYF = await this.getStoreValue('globalMaxYF') || 0;
    this.peakPowerAllTime = await this.getStoreValue('peakPowerAllTime') || 0;
    this.lastAutoRetrain = await this.getStoreValue('lastAutoRetrain') || 0;
    this.lastSolarTriggerSlot = -1;
    this.manualCurtailment = await this.getStoreValue('manualCurtailment') || false;
    this.trainingCoverageDays = await this.getStoreValue('trainingCoverageDays') || 0;
    this.trainingConfidence = await this.getStoreValue('trainingConfidence') || new Array(96).fill(0);
    this.lastRetrainFinishedAt = await this.getStoreValue('lastRetrainFinishedAt') || 0;
    await this.updateTrainingStatus();

    if (this.sessionId !== sessionIdAfterSuper) return; // superseded by a newer onInit()
    this.startForecastLoop().catch(this.error);
    if (this.forecastData && Object.keys(this.forecastData).length > 0) {
      this.updateForecastDisplay(false).catch(this.error);
    }
    // Delayed, to let the source device settle
    if (this.initLearningTimeout) this.homey.clearTimeout(this.initLearningTimeout);
    const finishInit = async () => {
      // History for the charts (e.g. after an app update)
      await this.populatePowerHistory();
      if (!storedYieldFactors) {
        await this.attemptInitialBackfill();
      }
      this.startLearningLoop().catch(this.error); // after the retrain
      this.initLearningTimeout = null;
    };
    this.initLearningTimeout = this.homey.setTimeout(() => {
      finishInit().catch(this.error);
    }, 15000);
  }

  // The app API may still be connecting after pairing, and retrainSolarModel() swallows "API not
  // ready": retry, or a device paired then never gets its one-time backfill (as in grid).
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
          + 'giving up. Yield factor model will build up via the nightly retrain instead.');
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
    this.log('First initialization: Auto-starting model retraining...');
    await this.retrainSolarModel(true);
  }

  // While undertrained the bootstrap warning, before the price warning of the base class.
  deviceWarning() {
    if ((this.trainingCoverageDays || 0) < BOOTSTRAP_THRESHOLD_DAYS) return this.homey.__('solar_bootstrap_warning');
    return super.deviceWarning();
  }

  // trainingCoverageDays (set per retrain) against the 14-day window: a device warning while
  // undertrained, and the settings label "training_status".
  async updateTrainingStatus() {
    const days = this.trainingCoverageDays || 0;

    await this.updateWarning().catch(this.error);
    if (days < BOOTSTRAP_THRESHOLD_DAYS) {
      await this.setSettings({
        training_status: this.homey.__('solar_bootstrap_status', { days: days.toFixed(1) }),
      }).catch(this.error);
    } else {
      const lastRetrainDate = this.lastRetrainFinishedAt ? new Date(this.lastRetrainFinishedAt) : new Date();
      await this.setSettings({
        training_status: this.homey.__('solar_trained_status', { date: lastRetrainDate.toLocaleDateString('en-CA') }),
      }).catch(this.error);
    }

    // Not on every reading: the label is refreshed with training_status.
    await this.setSettings({ peakPowerAllTime: String(Math.round(this.peakPowerAllTime || 0)) }).catch(this.error);
  }

  shouldUpdateCurrencyOnAdd() {
    return true;
  }

  // --- Solar Logic ---

  async startForecastLoop() {
    // Idempotent; the epoch makes an invocation already running stand down (as in grid
    // startForecastLoop()).
    if (this.forecastTimeout) this.homey.clearTimeout(this.forecastTimeout);
    this.forecastEpoch = (this.forecastEpoch || 0) + 1;
    const epoch = this.forecastEpoch;
    const loop = async () => {
      if (this.isDestroyed || epoch !== this.forecastEpoch) return;
      try {
        await this.fetchForecast();
        await this.updateForecastDisplay(false);

        // Nightly retrain at 01:00 local time
        const now = new Date();
        // Local hour: Homey runs in UTC
        const localNow = TimeHelpers.toLocalDate(now, this.timeZone);
        if (localNow.getHours() === 1) {
          const lastRun = new Date(this.lastAutoRetrain);
          const isSameLocalDay = lastRun.toLocaleDateString('en-CA', { timeZone: this.timeZone })
            === localNow.toLocaleDateString('en-CA', { timeZone: this.timeZone });

          if (!isSameLocalDay) {
            this.log('Running automatic nightly solar model retraining...');
            await this.retrainSolarModel(false);
            this.lastAutoRetrain = now.getTime();
            await this.setStoreValue('lastAutoRetrain', this.lastAutoRetrain);
          }
        }
      } catch (err) {
        this.error('Forecast fetch failed:', err);
      } finally {
        if (!this.isDestroyed && epoch === this.forecastEpoch) {
          this.forecastTimeout = this.homey.setTimeout(() => {
            loop().catch(this.error);
          }, 60 * 60 * 1000);
        }
      }
    };
    await loop();
  }

  async startLearningLoop() {
    // Every minute: curtailment detection, the h0 forecast, power history and self-consumption.
    // The model itself is only written by retrainSolarModel(). Idempotent, as startForecastLoop().
    if (this.learningTimeout) this.homey.clearTimeout(this.learningTimeout);
    this.learningEpoch = (this.learningEpoch || 0) + 1;
    const epoch = this.learningEpoch;
    const loop = async () => {
      if (this.isDestroyed || epoch !== this.learningEpoch) return;
      try {
        // Paused while a retrain runs
        if (!this.retraining) {
          await this.updateLearning();
          const now = new Date();
          const is15mBoundary = (now.getMinutes() % 15 === 0);
          if (this.forecastChanged || is15mBoundary || !this.chartSolarToday) {
            await this.updateForecastDisplay(false);
          }
        }
      } catch (err) {
        this.error('Learning update failed:', err);
      } finally {
        if (!this.isDestroyed && epoch === this.learningEpoch) {
          const now = new Date();
          const { start: sunStart, end: sunEnd } = SolarLearningStrategy.getSunBounds(now, this.forecastData, this.timeZone);
          const isNight = sunStart && sunEnd && (now < sunStart || now > sunEnd);

          const nextSlot = new Date(now);
          const currentMins = now.getMinutes();
          if (isNight) {
            nextSlot.setMinutes(Math.floor(currentMins / 15) * 15 + 15, 0, 0);
          } else {
            nextSlot.setMinutes(currentMins + 1, 0, 0);
          }
          let delay = nextSlot - now;
          if (delay < 1000) delay += (isNight ? 15 : 1) * 60 * 1000;
          this.learningTimeout = this.homey.setTimeout(() => {
            loop().catch(this.error);
          }, delay);
        }
      }
    };
    await loop();
  }

  async fetchForecast() {
    let { lat, lon } = this.getSettings();

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
      // Eclipse correction (Open-Meteo ignores eclipses), before the time shift: it is tied to
      // astronomical time.
      this.eclipseCache = this.eclipseCache || {};
      const eclipseAdjusted = SolarEclipse.applyToForecast(data, lat, lon, this.eclipseCache);

      const timeShift = this.getSettings().solar_time_shift || 0;
      if (timeShift !== 0) {
        const shiftedData = {};
        Object.keys(eclipseAdjusted).forEach((t) => {
          const newTime = Number(t) + (timeShift * 3600000);
          shiftedData[newTime] = eclipseAdjusted[t];
        });
        this.forecastData = shiftedData;
      } else {
        this.forecastData = eclipseAdjusted;
      }

      await this.setStoreValue('forecastData', this.forecastData);
      this.log('Forecast updated');
      this.forecastChanged = true;
    }
  }

  async updateLearning() {
    const now = new Date();
    const currentTimestamp = now.getTime();

    const rawPower = this.getCapabilityValue('measure_power');
    const currentEnergy = this.getCapabilityValue('meter_power');

    const deltaTmMs = currentTimestamp - (this.lastLearningTimestamp || currentTimestamp);
    this.lastLearningTimestamp = currentTimestamp;
    if (deltaTmMs > 0 && deltaTmMs < 300000) { // max 5 min gap
      const scPower = this.currentSelfConsumedPower !== undefined ? this.currentSelfConsumedPower : (rawPower || 0);
      const deltaKwh = (Math.max(0, scPower) * deltaTmMs) / 3600000000;
      this.meterSelfConsumed += deltaKwh;

      const safePower = Math.max(0, rawPower || 0);
      const deltaTotalKwh = (safePower * deltaTmMs) / 3600000000;
      this.meterTotalIntegrated = (this.meterTotalIntegrated || 0) + deltaTotalKwh;

      // Stored at most every 15 minutes
      if (!this.lastMeterIntegratedSaveTm || (currentTimestamp - this.lastMeterIntegratedSaveTm > 15 * 60 * 1000)) {
        this.setStoreValue('meterSelfConsumed', this.meterSelfConsumed).catch(this.error);
        this.setStoreValue('meterTotalIntegrated', this.meterTotalIntegrated).catch(this.error);
        this.lastMeterIntegratedSaveTm = currentTimestamp;
      }
    }

    const { smoothedPower, newEnergyState } = SolarLearningStrategy.calculateSmoothedPower({
      currentPower: rawPower,
      currentEnergy,
      lastEnergyState: this.lastEnergyState,
      currentTimestamp,
    });
    this.lastEnergyState = newEnergyState;
    const currentPower = smoothedPower;

    if (typeof currentPower === 'number') {
      if (currentPower > this.peakPowerAllTime) {
        this.peakPowerAllTime = currentPower;
        this.setStoreValue('peakPowerAllTime', this.peakPowerAllTime).catch(this.error);
      }

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      const lastEntry = this.powerHistory[this.powerHistory.length - 1];
      // One entry per 5 minutes: the 576-entry cap is 48 h at that spacing.
      if (!lastEntry || (currentTimestamp - lastEntry.time) > 5 * 60 * 1000) {
        this.powerHistory.push({ time: currentTimestamp, power: currentPower });
        if (this.powerHistory.length > 576) this.powerHistory.shift();
        if (!this.lastPowerHistorySaveTm || (currentTimestamp - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
          await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
          this.lastPowerHistorySaveTm = currentTimestamp;
        }

        const peak = Math.max(this.peakPowerAllTime || 0, this.getSettings().peakPower || 0);

        const curtailment = SolarLearningStrategy.detectCurtailment({
          currentPower,
          lastPower: lastEntry ? lastEntry.power : 0,
          forecastData: this.forecastData,
          yieldFactors: this.yieldFactors,
          isCurtailmentActive: this.getCapabilityValue('alarm_power'),
          timestamp: now,
          manualCurtailment: this.manualCurtailment || false,
          peakPower: peak,
        });

        if (curtailment.changed) {
          await this.setCapabilityValue('alarm_power', curtailment.isActive).catch(this.error);
          if (curtailment.log) this.log(curtailment.log);

          // Curtailment flow cards
          let app;
          try {
            app = this.homey.app;
          } catch {
            // ignore
          }
          if (curtailment.isActive && app && app.trigger_solar_curtailment_active) {
            app.trigger_solar_curtailment_active(this, {}, {}).catch(this.error);
          } else if (!curtailment.isActive && app && app.trigger_solar_curtailment_inactive) {
            app.trigger_solar_curtailment_inactive(this, {}, {}).catch(this.error);
          }
        }
      }
    }
  }

  // Finds a usable Insights log (:energy_power, else :meter_power converted) by test-fetching for
  // real (>10 W) data: a log can exist without values.
  async findTargetInsightsLog(api, sourceDevice, startDate14, endDate) {
    let allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
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
        if ((candidate.id || candidate.uri || '').endsWith(':meter_power')) entries = convertCumulativeToPower(entries);
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

    const isCumulative = (targetLog.id || targetLog.uri || '').endsWith(':meter_power');
    if (isCumulative) this.log('Using cumulative energy log (converting to power)...');

    return { targetLog, isCumulative };
  }

  async retrainSolarModel(fromScratch = false) {
    if (this.retraining) {
      this.log('Already retraining, skipping...');
      return;
    }
    this.retraining = true; // Pauses live updates
    this.log(`Starting solar model retraining... (Mode: ${fromScratch ? 'From Scratch' : 'Blend'})`);

    if (this.manualCurtailment) {
      this.manualCurtailment = false;
      await this.setStoreValue('manualCurtailment', false).catch(this.error);
      await this.setCapabilityValue('alarm_power', false).catch(this.error);
      this.log('Reset manual curtailment due to model retrain');
    }

    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch {
        // ignore
      }
      if (!api) throw new Error('Homey API not ready');

      const sourceDevice = await this.getSourceDevice();
      if (!sourceDevice) throw new Error('No source device found');
      this.log('Source Device ID:', sourceDevice.id);

      // 1. Weather history (14 days)
      const endDate = new Date();
      const startDate14 = new Date();
      startDate14.setDate(startDate14.getDate() - 14);

      let { lat, lon } = this.getSettings();
      if (!lat || !lon) {
        lat = this.homey.geolocation.getLatitude();
        lon = this.homey.geolocation.getLongitude();
      }
      if (!lat || !lon) throw new Error('Location not set');

      lat = Number(lat);
      lon = Number(lon);

      this.log(`Fetching weather history from ${startDate14.toISOString()}`);
      const weatherHistory = await OpenMeteo.fetchHistoric(lat, lon, startDate14, endDate);
      if (!weatherHistory || weatherHistory.length === 0) {
        throw new Error('No historic weather data found');
      }
      this.log(`Got ${weatherHistory.length} weather samples`);

      // Eclipse correction before the time shift; same cache as fetchForecast().
      this.eclipseCache = this.eclipseCache || {};
      const eclipseMap = SolarEclipse.applyToForecast(
        weatherHistory.reduce((m, e) => {
          m[e.time] = e.radiation; return m;
        }, {}),
        lat,
        lon,
        this.eclipseCache,
      );
      weatherHistory.forEach((e) => {
        e.radiation = eclipseMap[e.time];
      });

      const timeShift = this.getSettings().solar_time_shift || 0;
      if (timeShift !== 0) {
        this.log(`Applying time shift of ${timeShift} hours to weather data`);
        weatherHistory.forEach((w) => {
          w.time += timeShift * 3600000;
        });
      }

      const freshForecast = {};
      weatherHistory.forEach((e) => {
        freshForecast[e.time] = e.radiation;
      });
      this.forecastData = { ...this.forecastData, ...freshForecast };
      await this.setStoreValue('forecastData', this.forecastData);
      this.forecastChanged = true;

      const { targetLog, isCumulative } = await this.findTargetInsightsLog(api, sourceDevice, startDate14, endDate);

      // Samples of step 1 (hourly) and step 2 (5-min), aggregated once at the end.
      let slotSamples1 = new Array(96).fill(0).map(() => []);
      let slotSamples2 = new Array(96).fill(0).map(() => []);

      const peakPowerSetting = this.getSettings().peakPower || 0;
      // Without a Peak Power setting the observed all-time peak is used, but only for the soft
      // ceilings (they only loosen); never for the hard reject filter, as it starts low and grows.
      const effectivePeakPower = peakPowerSetting > 0 ? peakPowerSetting : this.peakPowerAllTime;

      // 3. Step 1: hourly, 14 days
      this.log('Step 1: Coarse learning (14 days, hourly)');
      try {
        const logs14 = await api.insights.getLogEntries({
          id: targetLog.id,
          start: startDate14.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last14Days',
        });

        // Training coverage from the fetched data (see updateTrainingStatus()).
        if (logs14 && logs14.values && logs14.values.length > 0) {
          const earliestMs = Math.min(...logs14.values.map((e) => new Date(e.t).getTime()));
          const coverageDays = Math.min(14, (endDate.getTime() - earliestMs) / (24 * 60 * 60 * 1000));
          this.trainingCoverageDays = Math.round(coverageDays * 10) / 10;
          await this.setStoreValue('trainingCoverageDays', this.trainingCoverageDays);
          await this.updateTrainingStatus();
        }

        if (logs14 && logs14.values && logs14.values.length > 50) {
          // Without the last 24 h: step 2 covers those at higher resolution
          const cutoffTime = new Date();
          cutoffTime.setDate(cutoffTime.getDate() - 1);
          let powerEntries = logs14.values.filter((e) => new Date(e.t) < cutoffTime);

          if (isCumulative) {
            powerEntries = convertCumulativeToPower(powerEntries);
          }

          let maxSeen = 0;
          powerEntries.forEach((e) => {
            const p = e.y !== undefined ? e.y : e.v;
            if (typeof p === 'number' && p > maxSeen) maxSeen = p;
          });
          if (maxSeen > this.peakPowerAllTime) {
            this.peakPowerAllTime = maxSeen;
            await this.setStoreValue('peakPowerAllTime', this.peakPowerAllTime);
          }

          const history = powerEntries.map((e) => ({
            time: new Date(e.t).getTime(),
            power: e.y !== undefined ? e.y : e.v,
          })).filter((e) => typeof e.power === 'number');
          this.powerHistory = history;

          const result1 = SolarLearningStrategy.extractSlotSamples({
            powerEntries,
            weatherEntries: weatherHistory,
            resolution: 'hourly',
            peakPower: peakPowerSetting,
            lat,
            lon,
            logger: (msg) => this.log(msg),
          });
          slotSamples1 = result1.slotSamples;
          this.log(`Step 1 complete: extracted samples from ${powerEntries.length} entries `
            + `(max power seen: ${result1.maxPowerSeen.toFixed(1)}W).`);
        } else {
          this.log('Step 1 skipped: Insufficient hourly data.');
        }
      } catch (e) {
        this.error('Step 1 failed:', e);
      }

      // 4. Step 2: 5-minute, 24 hours
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

          let maxSeen2 = 0;
          powerEntries.forEach((e) => {
            const p = e.y !== undefined ? e.y : e.v;
            if (typeof p === 'number' && p > maxSeen2) maxSeen2 = p;
          });
          if (maxSeen2 > this.peakPowerAllTime) {
            this.peakPowerAllTime = maxSeen2;
            await this.setStoreValue('peakPowerAllTime', this.peakPowerAllTime);
          }

          const recentHistory = powerEntries.map((e) => ({
            time: new Date(e.t).getTime(),
            power: e.y !== undefined ? e.y : e.v,
          })).filter((e) => typeof e.power === 'number');

          if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
          if (recentHistory.length > 0) {
            const minRecentTime = recentHistory[0].time;
            this.powerHistory = this.powerHistory.filter((e) => e.time < minRecentTime);
            this.powerHistory = this.powerHistory.concat(recentHistory);
          }
          this.powerHistory.sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 576) this.powerHistory = this.powerHistory.slice(-576);
          await this.setStoreValue('powerHistory', this.powerHistory);
          this.lastPowerHistorySaveTm = Date.now();

          const result2 = SolarLearningStrategy.extractSlotSamples({
            powerEntries,
            weatherEntries: weatherHistory,
            resolution: 'high',
            peakPower: peakPowerSetting,
            lat,
            lon,
            logger: (msg) => this.log(msg),
          });
          slotSamples2 = result2.slotSamples;
          this.log(`Step 2 complete: extracted samples from ${powerEntries.length} entries `
            + `(max power seen: ${result2.maxPowerSeen.toFixed(1)}W).`);
        } else {
          this.log('Step 2 skipped: Insufficient high-res data.');
        }
      } catch (e) {
        this.error('Step 2 failed:', e);
      }

      // 5. Aggregate both steps, then blend with the previous model.
      const combinedSlotSamples = slotSamples1.map((samples, idx) => [...samples, ...slotSamples2[idx]]);
      const aggregateResult = SolarLearningStrategy.aggregateYieldFactors({
        combinedSlotSamples,
        peakPower: effectivePeakPower,
        logger: (msg) => this.log(msg),
      });
      this.log(aggregateResult.log);

      const mergeResult = SolarLearningStrategy.mergeYields({
        historicYields: aggregateResult.yieldFactors,
        previousYields: fromScratch ? new Array(96).fill(0) : this.yieldFactors,
        alpha: fromScratch ? 1.0 : 0.7, // 100% historic from scratch, else 70%
        limit: aggregateResult.limit,
        peakPower: effectivePeakPower,
        // scales alpha per slot (see mergeYields())
        trainingConfidence: aggregateResult.trainingConfidence,
      });
      this.yieldFactors = mergeResult.yieldFactors;
      this.log(mergeResult.log);

      // Not blended: reflects tonight's window only.
      this.trainingConfidence = aggregateResult.trainingConfidence;
      await this.setStoreValue('trainingConfidence', this.trainingConfidence);

      // p90, not the max: ignores isolated morning/evening spikes
      const activeYields = [...this.yieldFactors].filter((y) => y > 0).sort((a, b) => a - b);
      if (activeYields.length > 0) {
        const p90Index = Math.floor(activeYields.length * 0.90);
        this.globalMaxYF = activeYields[p90Index];
      } else {
        this.globalMaxYF = 0;
      }
      await this.setStoreValue('globalMaxYF', this.globalMaxYF);
      this.log(`New Global Max Yield Factor: ${this.globalMaxYF.toFixed(2)} (Est. Wpeak: ~${Math.round(this.globalMaxYF * 850)}W)`);

      await this.setStoreValue('yieldFactors', this.yieldFactors);

      this.lastRetrainFinishedAt = Date.now();
      await this.setStoreValue('lastRetrainFinishedAt', this.lastRetrainFinishedAt);
      await this.updateTrainingStatus();

      await this.updateForecastDisplay(true);
      this.log('Retraining finished.');
    } catch (err) {
      this.error('Retraining failed:', err);
    } finally {
      this.retraining = false;
    }
  }

  // Maintenance action: logs settings and raw Insights power (14 days hourly + 24 h 5-min) as JSON
  // for a diagnostics report. Read-only; no weather (re-fetchable from lat/lon).
  // Result shown via setWarning(): a thrown error shows no text in the mobile app, and a
  // notification is easily missed (both confirmed on a device).
  async exportDiagnostics() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready - please try again in a moment.');

    const sourceDevice = await this.getSourceDevice();
    if (!sourceDevice) throw new Error('No source device found');

    const endDate = new Date();
    const startDate14 = new Date();
    startDate14.setDate(startDate14.getDate() - 14);
    const startDate24h = new Date();
    startDate24h.setDate(startDate24h.getDate() - 1);

    const { targetLog, isCumulative } = await this.findTargetInsightsLog(api, sourceDevice, startDate14, endDate);

    const logs14 = await api.insights.getLogEntries({
      id: targetLog.id, start: startDate14.toISOString(), end: endDate.toISOString(), resolution: 'last14Days',
    });
    const logs24h = await api.insights.getLogEntries({
      id: targetLog.id, start: startDate24h.toISOString(), end: endDate.toISOString(), resolution: 'last24Hours',
    });

    let hourly14d = (logs14 && logs14.values) || [];
    let high24h = (logs24h && logs24h.values) || [];
    if (isCumulative) {
      hourly14d = convertCumulativeToPower(hourly14d);
      high24h = convertCumulativeToPower(high24h);
    }
    // { t, y }, as the CSVs in zzz_solarLearning_modelling/data
    const normalize = (entries) => entries
      .filter((e) => e && e.t !== undefined && (e.y !== undefined || e.v !== undefined))
      .map((e) => ({ t: e.t, y: e.y !== undefined ? e.y : e.v }));

    const { peakPower, lat, lon } = this.getSettings();
    const diagnostics = {
      exportedAt: new Date().toISOString(),
      homeyDeviceName: this.getName(),
      settings: { peakPower, lat, lon },
      sourceDeviceId: sourceDevice.id,
      isCumulativeSource: isCumulative,
      hourly_14d: normalize(hourly14d),
      high_res_24h: normalize(high24h),
    };

    this.log(`[SOLAR DIAGNOSTICS EXPORT] ${JSON.stringify(diagnostics)}`);

    await this.setWarning(this.homey.__('solar_export_diagnostics_popup')).catch(this.error);
  }

  async populatePowerHistory() {
    try {
      const now = Date.now();

      if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
      // ~40 hours are needed to cover yesterday morning
      const hasData = this.powerHistory.length > 24 && this.powerHistory[0].time < (now - 40 * 60 * 60 * 1000);
      const hasRecent = this.powerHistory.length > 0 && this.powerHistory[this.powerHistory.length - 1].time > (now - 6 * 60 * 60 * 1000);

      if (hasData && hasRecent) {
        return;
      }

      this.log('[populatePowerHistory] Populating power history from Insights...');

      let api;
      try {
        api = this.homey.app.api;
      } catch { }
      if (!api) {
        this.log('[populatePowerHistory] Homey API not ready');
        return;
      }

      const sourceDevice = await this.getSourceDevice();
      if (!sourceDevice) {
        this.log('[populatePowerHistory] No source device');
        return;
      }

      let allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const deviceLogs = allLogs.filter((log) => {
        const logId = log.id || log.uri || '';
        return logId.includes(sourceDevice.id) && !logId.includes('PH_');
      });

      const candidates = [
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':energy_power')),
        deviceLogs.find((log) => (log.id || log.uri || '').endsWith(':meter_power')),
      ].filter(Boolean);

      let targetLog = candidates[0]; // first if none has data
      for (const candidate of candidates) {
        const testLogs = await api.insights.getLogEntries({
          id: candidate.id,
          resolution: 'last14Days',
        }).catch(() => null);

        if (testLogs && testLogs.values && testLogs.values.length > 0) {
          let entries = testLogs.values;
          if ((candidate.id || candidate.uri || '').endsWith(':meter_power')) entries = convertCumulativeToPower(entries);
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

      const isCumulative = (targetLog.id || targetLog.uri || '').endsWith(':meter_power');

      this.log(`[populatePowerHistory] Fetching yesterday+today logs for ${targetLog.id || targetLog.uri}`);

      const logs = await fetchYesterdayAndToday(api, targetLog.id);

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

        if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
        const existingMap = new Map(this.powerHistory.map((e) => [e.time, e]));
        newHistory.forEach((e) => existingMap.set(e.time, e));

        this.powerHistory = Array.from(existingMap.values())
          .sort((a, b) => a.time - b.time)
          .slice(-2880);

        await this.setStoreValue('powerHistory', this.powerHistory);
        this.lastPowerHistorySaveTm = Date.now();
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

    // --- Forecast history (fixed Yesterday chart) ---
    const nowLocalStr = now.toLocaleDateString('en-CA', { timeZone: this.timeZone }); // YYYY-MM-DD

    // Real UTC instants of the local midnights; yieldFactors[] is indexed by UTC hour.
    const localDayStart = TimeHelpers.getLocalMidnightUTC(now, this.timeZone);
    const localDayEnd = new Date(localDayStart.getTime() + 26 * 60 * 60 * 1000);
    localDayEnd.setTime(TimeHelpers.getLocalMidnightUTC(localDayEnd, this.timeZone).getTime());

    // Rebuilt only when forecastData/yieldFactors or the date changed.
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const dateRolledOver = this.forecastHistory.today && this.forecastHistory.today.date !== nowLocalStr;
    const needsHistoryRebuild = yieldFactorsUpdated || !this.forecastHistory.today || dateRolledOver;

    if (needsHistoryRebuild) {
      const todaySeries = {};
      for (let t = localDayStart.getTime(); t < localDayEnd.getTime(); t += 15 * 60 * 1000) {
        const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
        const slotIndex = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
        const yf = this.yieldFactors[slotIndex] || 0;
        todaySeries[t] = Math.round(rad * yf);
      }

      if (dateRolledOver) {
        this.log(`[updateForecastDisplay] Rotating history. Moving ${this.forecastHistory.today.date} to Yesterday. New Today: ${nowLocalStr}`);
        this.forecastHistory.yesterday = this.forecastHistory.today;
        dayChanged = true;
      }

      // Backfill yesterday when missing, all-zero, or not on the local-midnight grid (snapshots from
      // an older getLocalMidnightUTC() bug).
      const yesterdayLocalStr = yesterday.toLocaleDateString('en-CA', { timeZone: this.timeZone });
      const localYesterdayStart = TimeHelpers.getLocalMidnightUTC(yesterday, this.timeZone);
      const localYesterdayEnd = localDayStart;

      const yesterdayIsDegenerate = this.forecastHistory.yesterday
        && !Object.values(this.forecastHistory.yesterday.data).some((v) => v > 0);
      const yesterdayKeysMisaligned = this.forecastHistory.yesterday
        && !Object.prototype.hasOwnProperty.call(this.forecastHistory.yesterday.data, String(localYesterdayStart.getTime()));
      if (!this.forecastHistory.yesterday || yesterdayIsDegenerate || yesterdayKeysMisaligned) {
        if (yesterdayKeysMisaligned && !yesterdayIsDegenerate) {
          this.log('[updateForecastDisplay] Yesterday snapshot keys are misaligned with the current local-midnight grid, rebuilding.');
        }
        const hasData = Object.keys(this.forecastData).some((t) => {
          const time = Number(t);
          return time >= localYesterdayStart.getTime() && time < localYesterdayEnd.getTime();
        });

        if (hasData) {
          this.log(`[updateForecastDisplay] Backfilling yesterday forecast for ${yesterdayLocalStr}`);
          const yesterdaySeries = {};
          for (let t = localYesterdayStart.getTime(); t < localYesterdayEnd.getTime(); t += 15 * 60 * 1000) {
            const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
            const slotIndex = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
            const yf = this.yieldFactors[slotIndex] || 0;
            yesterdaySeries[t] = Math.round(rad * yf);
          }
          this.forecastHistory.yesterday = { date: yesterdayLocalStr, data: yesterdaySeries };
          dayChanged = true;
        } else {
          this.log(`[updateForecastDisplay] Cannot backfill yesterday: No weather data for ${yesterdayLocalStr}`);
        }
      }

      this.forecastHistory.today = { date: nowLocalStr, data: todaySeries };
      await this.setStoreValue('forecastHistory', this.forecastHistory);
    }

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

    // Forecast this hour (h0)
    let forecastH0 = 0;
    const startOfHour = TimeHelpers.startOfLocalBlock(now, 60, this.timeZone);
    for (let i = 0; i < 4; i += 1) {
      const t = startOfHour + i * 15 * 60 * 1000;
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      const dateT = new Date(t);
      const slotIndex = (dateT.getUTCHours() * 4) + Math.floor(dateT.getUTCMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      const power = rad * yf; // W
      forecastH0 += (power * 0.25) / 1000; // kWh
    }
    await this.setCapabilityValue('meter_kwh_forecast.h0', Number(forecastH0.toFixed(2))).catch(this.error);
    await this.setCapabilityValue('meter_kwh_forecast.this_day', totalYield).catch(this.error);

    // Forecast tomorrow (real UTC boundaries, DST-safe)
    const localDayAfterTomorrowStart = TimeHelpers.getLocalMidnightUTC(
      new Date(localDayEnd.getTime() + 26 * 60 * 60 * 1000),
      this.timeZone,
    );
    let tomorrowYield = 0;
    let tomorrowPeak = 0;
    for (let t = localDayEnd.getTime(); t < localDayAfterTomorrowStart.getTime(); t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      const slotIndex = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] || 0;
      const power = rad * yf;
      if (Math.round(power) > tomorrowPeak) tomorrowPeak = Math.round(power);
      tomorrowYield += (power * 0.25) / 1000;
    }
    await this.setCapabilityValue('meter_kwh_forecast.tomorrow', Number(tomorrowYield.toFixed(2))).catch(this.error);
    await this.setCapabilityValue('measure_watt_forecast.tomorrow_peak', tomorrowPeak).catch(this.error);

    // --- Update Charts --- (not time-critical: after a slot boundary's burst, LoadSpread)
    // Calls merged into one deferred run: what any of them changed is drawn.
    const flags = {
      yieldFactorsUpdated, forecastChanged: this.forecastChanged, dayChanged, quarter: now.getMinutes() % 15 === 0, // forecastChanged: reset below
    };
    await LoadSpread.run(this, 'forecastCharts', async ({
      yieldFactorsUpdated: yfUpdated, forecastChanged, dayChanged: dayRolled, quarter,
    }) => {
      // Peak Power setting, else the higher of the all-time peak and an estimated Wpeak. 850 instead
      // of 1000: GHI is roughly 85% of a tilted roof's irradiance at summer peak (estimate).
      const estimatedWpeak = this.globalMaxYF > 0 ? Math.round(this.globalMaxYF * 850) : 0;
      const autoPeak = Math.max(this.peakPowerAllTime, estimatedWpeak);
      const currentSettings = this.getSettings();
      let chartPeak = currentSettings.peakPower;

      if (!chartPeak) {
        chartPeak = autoPeak;
      }

      if (yfUpdated || forecastChanged || quarter || !this.chartSolarToday) {
        const { start: todayStart, end: todayEnd } = SolarLearningStrategy.getSunBounds(now, this.forecastData, this.timeZone);

        const chartToday = await getSolarChart(this.forecastData, this.yieldFactors, todayStart, todayEnd, 'Forecast This Day', this.powerHistory, this.timeZone, chartPeak, true);
        if (chartToday) {
          this.chartSolarToday = chartToday;
          await this.solarTodayImage.update();
        }
      }

      if (yfUpdated || forecastChanged || !this.chartSolarTomorrow) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const { start: tomorrowStart, end: tomorrowEnd } = SolarLearningStrategy.getSunBounds(tomorrow, this.forecastData, this.timeZone);

        const chartTomorrow = await getSolarChart(this.forecastData, this.yieldFactors, tomorrowStart, tomorrowEnd, 'Forecast Tomorrow', this.powerHistory, this.timeZone, chartPeak, false);
        if (chartTomorrow) {
          this.chartSolarTomorrow = chartTomorrow;
          await this.solarTomorrowImage.update();
        }
      }

      if (this.forecastHistory.yesterday && (!this.chartSolarYesterday || yfUpdated || dayRolled)) {
        const frozenData = this.forecastHistory.yesterday.data;
        const { start: yStart, end: yEnd } = SolarLearningStrategy.getSunBounds(yesterday, frozenData, this.timeZone);

        // Yields of 1.0: frozenData is already power (W), not radiation
        const dummyYields = new Array(96).fill(1.0);
        const chartYesterday = await getSolarChart(frozenData, dummyYields, yStart, yEnd, 'Solar Yesterday', this.powerHistory, this.timeZone, chartPeak, false);

        if (chartYesterday) {
          this.chartSolarYesterday = chartYesterday;
          await this.solarYesterdayImage.update();
        }
      }

      if (yfUpdated || !this.chartSolarDistribution) {
        const chartDist = await getDistributionChart(this.yieldFactors, 'Yield Distribution', this.timeZone, this.trainingConfidence, {
          yieldFactor: this.homey.__('solar_chart_yield_factor'),
          modelFit: this.homey.__('solar_chart_model_fit'),
        });
        if (chartDist) {
          this.chartSolarDistribution = chartDist;
          await this.solarDistributionImage.update();
        }
      }
    }, flags);

    // Solar yield flows at the start of each 15-minute slot
    const currentSlot = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
    if (this.lastSolarTriggerSlot !== currentSlot || yieldFactorsUpdated || this.forecastChanged) {
      this.lastSolarTriggerSlot = currentSlot;
      if (typeof this.flows?.triggerSolarYieldFlows === 'function') {
        await this.flows.triggerSolarYieldFlows().catch((err) => this.error('Error triggering solar yield flows', err));
      }
    }

    if (yieldFactorsUpdated || this.forecastChanged) {
      await this.flows.triggerForecastUpdated().catch((err) => this.error('Error triggering forecast updated flows', err));
    }

    this.forecastChanged = false;
  }

  async getReadingObject(value) {
    const reading = await super.getReadingObject(value);
    reading.selfConsumed = this.meterSelfConsumed || 0;
    reading.totalIntegrated = this.meterTotalIntegrated || 0;
    return reading;
  }

  // handleUpdateMeter() runs serialized, so `periods` and the deltas can be taken before super
  // updates the lastReading objects.
  async handleUpdateMeter(reading) {
    const periods = this.getPeriods(reading);

    const valHour = reading.meterValue - (this.lastReadingHour?.meterValue || 0);
    const valHourSC = reading.selfConsumed - (this.lastReadingHour?.selfConsumed || 0);
    const valHourTot = this.lastReadingHour?.totalIntegrated !== undefined ? reading.totalIntegrated - this.lastReadingHour.totalIntegrated : valHour;

    const valDay = reading.meterValue - (this.lastReadingDay?.meterValue || 0);
    const valDaySC = reading.selfConsumed - (this.lastReadingDay?.selfConsumed || 0);
    const valDayTot = this.lastReadingDay?.totalIntegrated !== undefined ? reading.totalIntegrated - this.lastReadingDay.totalIntegrated : valDay;

    const valMonth = reading.meterValue - (this.lastReadingMonth?.meterValue || 0);
    const valMonthSC = reading.selfConsumed - (this.lastReadingMonth?.selfConsumed || 0);
    const valMonthTot = this.lastReadingMonth?.totalIntegrated !== undefined ? reading.totalIntegrated - this.lastReadingMonth.totalIntegrated : valMonth;

    const valYear = reading.meterValue - (this.lastReadingYear?.meterValue || 0);
    const valYearSC = reading.selfConsumed - (this.lastReadingYear?.selfConsumed || 0);
    const valYearTot = this.lastReadingYear?.totalIntegrated !== undefined ? reading.totalIntegrated - this.lastReadingYear.totalIntegrated : valYear;

    await super.handleUpdateMeter(reading);

    const setPct = async (cap, valSC, valTotal, isNewPeriod) => {
      if (valTotal > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((valSC / valTotal) * 100)));
        if (this.hasCapability(cap)) await this.setCapability(cap, pct);
      } else if (isNewPeriod && this.hasCapability(cap)) {
        await this.setCapability(cap, 0);
      }
    };

    await setPct('measure_solar_use.this_hour', valHourSC, valHourTot, periods.newHour);
    await setPct('measure_solar_use.this_day', valDaySC, valDayTot, periods.newDay);
    await setPct('measure_solar_use.this_month', valMonthSC, valMonthTot, periods.newMonth);
    await setPct('measure_solar_use.this_year', valYearSC, valYearTot, periods.newYear);
  }

  // Forecast power (W) per 15-minute slot from startMs (incl.) to endMs (excl.), real UTC ms.
  getForecastSeries(startMs, endMs) {
    const values = [];
    for (let t = startMs; t < endMs; t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData || {});
      // yieldFactors[] is indexed by real UTC hour.
      const slotIndex = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
      const yf = this.yieldFactors && this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      values.push(Math.round(rad * yf));
    }
    return values;
  }

  getForecastRemaining(targetDateLocal) {
    const now = new Date();
    const timezone = this.timeZone || 'UTC';
    const nowLocal = TimeHelpers.toLocalDate(now, timezone);

    if (targetDateLocal <= nowLocal) return 0;

    return this.getForecastBetween(nowLocal, targetDateLocal);
  }

  getForecastStatsBetween(startLocal, endLocal) {
    const now = new Date();
    const timezone = this.timeZone || 'UTC';
    const nowLocal = TimeHelpers.toLocalDate(now, timezone);

    // End before start: the next occurrence (e.g. 22:00 -> 06:00).
    const adjustedEnd = new Date(endLocal);
    if (adjustedEnd < startLocal) {
      adjustedEnd.setDate(adjustedEnd.getDate() + 1);
    }

    // Local to UTC with the current offset
    const offset = nowLocal.getTime() - now.getTime();
    const startTimeUTC = startLocal.getTime() - offset;
    const endTimeUTC = adjustedEnd.getTime() - offset;

    let totalYield = 0;
    let peakPower = 0;
    const startSlot = Math.ceil(startTimeUTC / (15 * 60 * 1000)) * 15 * 60 * 1000;

    for (let t = startSlot; t < endTimeUTC; t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.forecastData);
      // yieldFactors[] is indexed by real UTC hour.
      const slotIndex = (new Date(t).getUTCHours() * 4) + Math.floor(new Date(t).getUTCMinutes() / 15);
      const yf = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 0;
      const power = rad * yf; // W
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
  }

  async runFlowAction(id, args) {
    if (id === 'set_curtailment') {
      this.manualCurtailment = args.state === true;
      await this.setStoreValue('manualCurtailment', this.manualCurtailment).catch(this.error);
      await this.setCapabilityValue('alarm_power', this.manualCurtailment).catch(this.error);
      this.log(`Manual curtailment state updated via flow: ${this.manualCurtailment}`);
      return true;
    }
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Action ${id} not implemented`);
  }

  async runFlowCondition(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Condition ${id} not implemented`);
  }

  async runFlowTrigger(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Trigger ${id} not implemented`);
  }

}

module.exports = SolarDevice;
