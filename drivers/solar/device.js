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
const SourceDeviceHelper = require('../../lib/SourceDeviceHelper');
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
      await this.retrainSolarModel();
      return true;
    });

    // Initialize solar specific properties
    const storedYieldFactors = await this.getStoreValue('yieldFactors');
    this.yieldFactors = storedYieldFactors || new Array(96).fill(0);
    this.forecastData = await this.getStoreValue('forecastData') || {}; // { time: radiation }

    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    this.powerHistory = history
      .filter((e) => e && typeof e.time === 'number' && typeof e.power === 'number')
      .slice(-1500);
    if (this.powerHistory.length !== history.length) await this.setStoreValue('powerHistory', this.powerHistory);

    // Start loops
    this.startForecastLoop();
    // Delay learning loop to allow source device to settle/update
    if (this.initLearningTimeout) this.homey.clearTimeout(this.initLearningTimeout);
    this.initLearningTimeout = this.homey.setTimeout(async () => {
      this.startLearningLoop();
      if (!storedYieldFactors) {
        this.log('First initialization: Auto-starting model retraining...');
        await this.retrainSolarModel();
      }
      this.initLearningTimeout = null;
    }, 15000);
  }

  // --- Source Device Integration (Copied/Adapted from PowerDevice) ---

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async addSourceCapGroup() {
    // setup if/how a HOMEY-API source device fits to a defined capability group
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters
    this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible meter_power capabilities ${this.sourceDevice.capabilities}`);
    }
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    // start listener for METER_VIA_WATT device
    if (this.getSettings().use_measure_source) {
      if (this.sourceDevice.capabilities.includes('measure_power')) {
        this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
        this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
          await this.updateMeterFromMeasure(value).catch(this.error);
        });
        return;
      }
      throw Error(`${this.sourceDevice.name} has no measure_power capability ${this.sourceDevice.capabilities}`);
    }

    // start listeners for HOMEY-API device
    await this.addSourceCapGroup();
    this.log(`registering meter_power capability listener for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          this.lastGroupMeter[key] = value;
          await this.updateGroupMeter(value, key).catch(this.error);
        });
      }
    });

    // also listen to measure_power for better real-time updates
    if (this.sourceDevice.capabilities.includes('measure_power')) {
      this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
        await this.setCapability('measure_power', value).catch(this.error);
      });
    }
  }

  // Setup how to poll the meter
  async pollMeter() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      return;
    }
    if (!api) return;
    // poll a Homey Energy device
    if (this.getSettings().source_device_type.includes('Homey Energy')) {
      const report = await api.energy.getLiveReport().catch(this.error);
      const value = report[this.settings.homey_energy].W;
      await this.updateMeterFromMeasure(value).catch(this.error);
      return;
    }

    // check if HOMEY-API source device has a defined capability group setup
    if (!this.sourceCapGroup) await this.addSourceCapGroup();

    // get all values for this.lastGroupMeter
    await this.getSourceDevice();
    Object.keys(this.sourceCapGroup)
      .filter((k) => this.sourceCapGroup[k])
      .forEach((k) => {
        this.lastGroupMeter[k] = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[k]].value;
      });
    this.lastGroupMeterReady = true;
    await this.updateGroupMeter().catch(this.error);

    // also poll measure_power for better real-time updates
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_power) {
      await this.setCapability('measure_power', this.sourceDevice.capabilitiesObj.measure_power.value).catch(this.error);
    }
  }

  async updateGroupMeter() {
    // check if all GroupCaps have received their first value.
    if (!this.lastGroupMeterReady) {
      this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
      return;
    }
    // calculate the sum, and update meter
    let total = 0;
    total = Number.isFinite(this.lastGroupMeter.p1) ? total += this.lastGroupMeter.p1 : total;
    total = Number.isFinite(this.lastGroupMeter.p2) ? total += this.lastGroupMeter.p2 : total;
    total = Number.isFinite(this.lastGroupMeter.n1) ? total -= this.lastGroupMeter.n1 : total;
    total = Number.isFinite(this.lastGroupMeter.n2) ? total -= this.lastGroupMeter.n2 : total;
    await this.updateMeter(total).catch(this.error);
  }

  // --- Solar Logic ---

  async startForecastLoop() {
    // Fetch forecast every hour
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        await this.fetchForecast();
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
    // Update learning every 1 min
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
      this.forecastData = data;
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
        if (this.powerHistory.length > 1500) this.powerHistory.shift();
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

  async retrainSolarModel() {
    this.log('Starting solar model retraining...');
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

      // 2. Locate Insights Log
      const insightUri = `homey:device:${sourceDevice.id}:measure_power`;
      let allLogs = await api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const deviceLogs = allLogs.filter((log) => log.uri && log.uri.includes(sourceDevice.id));
      const availableCaps = deviceLogs.map((l) => l.uri.split(':').pop()).join(', ');
      this.log(`Available Insight logs for ${sourceDevice.name}: ${availableCaps}`);

      // Prioritize Power (W) over Energy (kWh)
      const targetLog = deviceLogs.find((log) => log.uri.endsWith(':measure_power'))
        || deviceLogs.find((log) => log.uri.endsWith(':energy_power'))
        || deviceLogs.find((log) => log.uri.endsWith(':meter_power'));

      if (!targetLog) {
        throw new Error(`Insights log not found for ${insightUri}. Available logs: ${availableCaps || 'none'}`);
      }
      this.log(`Found target log: ${targetLog.name || 'unknown'} (ID: ${targetLog.id})`);

      const isCumulative = targetLog.uri.endsWith(':meter_power');
      if (isCumulative) this.log('Using cumulative energy log (converting to power)...');

      // Initialize fresh yield factors for training to remove old artifacts
      let trainingYieldFactors = new Array(96).fill(0);

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

          const result1 = SolarLearningStrategy.processHistoricData({
            powerEntries,
            weatherEntries: weatherHistory,
            currentYieldFactors: trainingYieldFactors,
            resolution: 'hourly',
          });
          if (result1.updated) {
            trainingYieldFactors = result1.yieldFactors;
            step1Accumulators = result1.slotAccumulators;
            this.log(`Step 1 complete: ${result1.log}`);
          } else {
            this.log('Step 1: No updates derived from data.');
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

          const result2 = SolarLearningStrategy.processHistoricData({
            powerEntries,
            weatherEntries: weatherHistory,
            currentYieldFactors: trainingYieldFactors,
            previousAccumulators: step1Accumulators,
            resolution: 'high',
          });
          if (result2.updated) {
            trainingYieldFactors = result2.yieldFactors;
            this.log(`Step 2 complete: ${result2.log}`);
          } else {
            this.log('Step 2: No updates derived from data.');
          }
        } else {
          this.log('Step 2 skipped: Insufficient high-res data.');
        }
      } catch (e) {
        this.error('Step 2 failed:', e);
      }

      // 5. Save and Update
      this.yieldFactors = trainingYieldFactors;
      await this.setStoreValue('yieldFactors', this.yieldFactors);
      await this.updateForecastDisplay(true);
      this.log('Retraining finished.');
    } catch (err) {
      this.error('Retraining failed:', err);
    }
  }

  async updateForecastDisplay(yieldFactorsUpdated = false) {
    const now = new Date();

    const { expectedPower, totalYield } = SolarLearningStrategy.calculateForecast({
      forecastData: this.forecastData,
      yieldFactors: this.yieldFactors,
      timestamp: now,
      timezone: this.timeZone,
    });

    await this.setCapabilityValue('measure_power.forecast', expectedPower).catch(this.error);
    await this.setCapabilityValue('meter_power.forecast', totalYield).catch(this.error);

    // --- Update Charts ---

    // 1. Today
    const { start: todayStart, end: todayEnd } = SolarLearningStrategy.getSunBounds(now, this.forecastData, this.timeZone);

    const urlToday = await getSolarChart(this.forecastData, this.yieldFactors, todayStart, todayEnd, 'Forecast Today', this.powerHistory, this.timeZone);
    if (urlToday) {
      const url = `${urlToday}${urlToday.includes('?') ? '&' : '?'}t=${Date.now()}`;
      if (!this.solarTodayImage) {
        this.solarTodayImage = await this.homey.images.createImage();
        await this.setCameraImage('solarToday', 'Solar Today', this.solarTodayImage);
      }
      this.solarTodayImage.setStream(async (stream) => imageUrlToStream(url, stream, this));
      await this.solarTodayImage.update();
    }

    // 2. Tomorrow
    if (yieldFactorsUpdated || this.forecastChanged || !this.solarTomorrowImage) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { start: tomorrowStart, end: tomorrowEnd } = SolarLearningStrategy.getSunBounds(tomorrow, this.forecastData, this.timeZone);

      const urlTomorrow = await getSolarChart(this.forecastData, this.yieldFactors, tomorrowStart, tomorrowEnd, 'Forecast Tomorrow', this.powerHistory, this.timeZone);
      if (urlTomorrow) {
        const url = `${urlTomorrow}${urlTomorrow.includes('?') ? '&' : '?'}t=${Date.now()}`;
        if (!this.solarTomorrowImage) {
          this.solarTomorrowImage = await this.homey.images.createImage();
          await this.setCameraImage('solarTomorrow', 'Solar Tomorrow', this.solarTomorrowImage);
        }
        this.solarTomorrowImage.setStream(async (stream) => imageUrlToStream(url, stream, this));
        await this.solarTomorrowImage.update();
      }
    }

    // 3. Distribution
    if (yieldFactorsUpdated || !this.solarDistributionImage) {
      const urlDist = await getDistributionChart(this.yieldFactors, 'Yield Distribution', this.timeZone);
      if (urlDist) {
        const url = `${urlDist}${urlDist.includes('?') ? '&' : '?'}t=${Date.now()}`;
        if (!this.solarDistributionImage) {
          this.solarDistributionImage = await this.homey.images.createImage();
          await this.setCameraImage('solarDistribution', 'Solar Distribution', this.solarDistributionImage);
        }
        this.solarDistributionImage.setStream(async (stream) => imageUrlToStream(url, stream, this));
        await this.solarDistributionImage.update();
      }
    }

    this.forecastChanged = false;
  }

  async retrain_solar_model() {
    return this.retrainSolarModel();
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

}

module.exports = SolarDevice;
