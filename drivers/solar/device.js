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
const { getSolarChart } = require('../../lib/charts/SolarChart');
const OpenMeteo = require('../../lib/providers/OpenMeteo');
const SolarLearningStrategy = require('../../lib/strategies/SolarLearningStrategy');
const { setTimeoutPromise } = require('../../lib/Util');
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

class SolarDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
    this.flows = new SolarFlows(this);

    this.registerCapabilityListener('button.retrain', async () => {
      await this.retrainSolarModel();
      return true;
    });

    // Initialize solar specific properties
    const storedYieldFactors = await this.getStoreValue('yieldFactors');
    this.yieldFactors = storedYieldFactors || new Array(96).fill(1.0);
    this.forecastData = await this.getStoreValue('forecastData') || {}; // { time: radiation }

    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    this.powerHistory = history
      .filter((e) => e && typeof e.time === 'number' && typeof e.power === 'number')
      .slice(-400);
    if (this.powerHistory.length !== history.length) await this.setStoreValue('powerHistory', this.powerHistory);

    // Start loops
    this.startForecastLoop();
    // Delay learning loop to allow source device to settle/update
    setTimeoutPromise(15000, this).then(async () => {
      this.startLearningLoop();
      if (!storedYieldFactors) {
        this.log('First initialization: Auto-starting model retraining...');
        await this.retrainSolarModel();
      }
    });
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
    if (!this.homey.app.api) throw new Error('Homey API not ready');
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
    if (!this.homey.app.api) return;
    // poll a Homey Energy device
    if (this.getSettings().source_device_type.includes('Homey Energy')) {
      const report = await this.homey.app.api.energy.getLiveReport().catch(this.error);
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
        await this.updateLearning();
        await this.updateForecastDisplay();
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
    }
  }

  async updateLearning() {
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
        if (this.powerHistory.length > 400) this.powerHistory.shift();
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
    const currentSlotIndex = (now.getHours() * 4) + Math.floor(now.getMinutes() / 15);
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
        }
      }
    }
  }

  async retrainSolarModel() {
    this.log('Starting solar model retraining...');
    try {
      if (!this.homey.app.api) throw new Error('Homey API not ready');

      const sourceDevice = await this.getSourceDevice();
      if (!sourceDevice) throw new Error('No source device found');
      this.log('Source Device ID:', sourceDevice.id);

      // 1. Fetch Weather History (31 days) - needed for both steps
      const endDate = new Date();
      const startDate31 = new Date();
      startDate31.setDate(startDate31.getDate() - 31);

      let { lat, lon } = this.getSettings();
      if (!lat || !lon) {
        lat = this.homey.geolocation.getLatitude();
        lon = this.homey.geolocation.getLongitude();
      }
      if (!lat || !lon) throw new Error('Location not set');

      this.log(`Fetching weather history from ${startDate31.toISOString()}`);
      const weatherHistory = await OpenMeteo.fetchHistoric(lat, lon, startDate31, endDate);
      if (!weatherHistory || weatherHistory.length === 0) {
        throw new Error('No historic weather data found');
      }
      this.log(`Got ${weatherHistory.length} weather samples`);

      // 2. Locate Insights Log
      const insightUri = `homey:device:${sourceDevice.id}:measure_power`;
      let allLogs = await this.homey.app.api.insights.getLogs().catch(() => []);
      if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs);

      const deviceLogs = allLogs.filter((log) => log.uri && log.uri.includes(sourceDevice.id));
      let targetLog = deviceLogs.find((log) => log.uri.endsWith(':measure_power'));
      if (!targetLog) targetLog = deviceLogs.find((log) => log.uri.endsWith(':energy_power'));

      if (!targetLog) {
        const availableCaps = deviceLogs.map((l) => l.uri.split(':').pop()).join(', ');
        throw new Error(`Insights log not found for ${insightUri}. Available logs: ${availableCaps || 'none'}`);
      }
      this.log(`Found target log: ${targetLog.name || 'unknown'} (ID: ${targetLog.id})`);

      // 3. Step 1: Coarse Learning (31 days, hourly)
      this.log('Step 1: Coarse learning (31 days, hourly)');
      try {
        const logs31 = await this.homey.app.api.insights.getLogEntries({
          id: targetLog.id,
          start: startDate31.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last31Days',
        });

        if (logs31 && logs31.values && logs31.values.length > 50) {
          const result1 = SolarLearningStrategy.processHistoricData({
            powerEntries: logs31.values,
            weatherEntries: weatherHistory,
            currentYieldFactors: this.yieldFactors,
            resolution: 'hourly',
          });
          if (result1.updated) {
            this.yieldFactors = result1.yieldFactors;
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

      // 4. Step 2: Fine Tuning (7 days, 15m)
      this.log('Step 2: Fine tuning (7 days, 15m)');
      try {
        const startDate7 = new Date();
        startDate7.setDate(startDate7.getDate() - 7);

        const logs7 = await this.homey.app.api.insights.getLogEntries({
          id: targetLog.id,
          start: startDate7.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last7Days',
        });

        if (logs7 && logs7.values && logs7.values.length > 50) {
          const result2 = SolarLearningStrategy.processHistoricData({
            powerEntries: logs7.values,
            weatherEntries: weatherHistory,
            currentYieldFactors: this.yieldFactors,
            resolution: 'high',
          });
          if (result2.updated) {
            this.yieldFactors = result2.yieldFactors;
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
      await this.setStoreValue('yieldFactors', this.yieldFactors);
      await this.updateForecastDisplay();
      this.log('Retraining finished.');
    } catch (err) {
      this.error('Retraining failed:', err);
    }
  }

  async updateForecastDisplay() {
    const now = new Date();
    const hourTime = new Date(now);
    hourTime.setMinutes(0, 0, 0);
    const forecastRadiation = this.forecastData[hourTime.getTime()] || 0;

    const slotIndex = (now.getHours() * 4) + Math.floor(now.getMinutes() / 15);
    const yieldFactor = this.yieldFactors[slotIndex] !== undefined ? this.yieldFactors[slotIndex] : 1.0;

    const expectedPower = forecastRadiation * yieldFactor;
    await this.setCapabilityValue('measure_power.forecast', Math.round(expectedPower)).catch(this.error);

    // Calculate total expected yield for today
    let totalYield = 0;
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    // Iterate 96 slots of today
    for (let i = 0; i < 96; i++) {
      // Calculate timestamp for this slot
      const slotTime = new Date(startOfDay.getTime() + (i * 15 * 60 * 1000));
      // Align to hour for forecast lookup
      slotTime.setMinutes(0, 0, 0);
      const rad = this.forecastData[slotTime.getTime()] || 0;
      const yf = this.yieldFactors[i] !== undefined ? this.yieldFactors[i] : 1.0;
      const power = rad * yf;
      // Power (W) * 0.25h / 1000 = kWh
      totalYield += (power * 0.25) / 1000;
    }

    await this.setCapabilityValue('meter_power.forecast', Number(totalYield.toFixed(2))).catch(this.error);

    // --- Update Charts ---

    const getSunBounds = (dateObj) => {
      const startOfDay = new Date(dateObj);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      const noon = new Date(startOfDay);
      noon.setHours(12, 0, 0, 0);

      const timestamps = Object.keys(this.forecastData)
        .map(Number)
        .filter((ts) => ts >= startOfDay.getTime() && ts < endOfDay.getTime() && this.forecastData[ts] > 0)
        .sort((a, b) => a - b);

      if (timestamps.length === 0) {
        const s = new Date(noon); s.setHours(3, 0, 0, 0);
        const e = new Date(noon); e.setHours(21, 0, 0, 0);
        return { start: s, end: e };
      }

      const start = new Date(timestamps[0]);
      start.setHours(start.getHours() - 1);

      const end = new Date(timestamps[timestamps.length - 1]);
      end.setHours(end.getHours() + 2);

      const diff = Math.max(noon - start, end - noon);
      return { start: new Date(noon.getTime() - diff), end: new Date(noon.getTime() + diff) };
    };

    // 1. Today
    const { start: todayStart, end: todayEnd } = getSunBounds(now);

    const urlToday = await getSolarChart(this.forecastData, this.yieldFactors, todayStart, todayEnd, 'Forecast Today', this.powerHistory);
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
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const { start: tomorrowStart, end: tomorrowEnd } = getSunBounds(tomorrow);

    const urlTomorrow = await getSolarChart(this.forecastData, this.yieldFactors, tomorrowStart, tomorrowEnd, 'Forecast Tomorrow', this.powerHistory);
    if (urlTomorrow) {
      const url = `${urlTomorrow}${urlTomorrow.includes('?') ? '&' : '?'}t=${Date.now()}`;
      if (!this.solarTomorrowImage) {
        this.solarTomorrowImage = await this.homey.images.createImage();
        await this.setCameraImage('solarTomorrow', 'Solar Tomorrow', this.solarTomorrowImage);
      }
      this.solarTomorrowImage.setStream(async (stream) => imageUrlToStream(url, stream, this));
      await this.solarTomorrowImage.update();
    }

    // 3. Next Hours (e.g. 8 hours)
    const nextStart = new Date(now);
    const nextEnd = new Date(now);
    nextEnd.setHours(nextEnd.getHours() + 8);

    const urlNext = await getSolarChart(this.forecastData, this.yieldFactors, nextStart, nextEnd, 'Forecast Next 8h', this.powerHistory);
    if (urlNext) {
      const url = `${urlNext}${urlNext.includes('?') ? '&' : '?'}t=${Date.now()}`;
      if (!this.solarNextImage) {
        this.solarNextImage = await this.homey.images.createImage();
        await this.setCameraImage('solarNext', 'Solar Next 8h', this.solarNextImage);
      }
      this.solarNextImage.setStream(async (stream) => imageUrlToStream(url, stream, this));
      await this.solarNextImage.update();
    }
  }

  async onUninit() {
    if (this.forecastTimeout) this.homey.clearTimeout(this.forecastTimeout);
    if (this.learningTimeout) this.homey.clearTimeout(this.learningTimeout);
    await super.onUninit();
  }

}

module.exports = SolarDevice;
