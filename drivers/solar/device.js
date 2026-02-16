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

const GenericDevice = require('../../lib/generic_sum_device');
const SourceDeviceHelper = require('../../lib/SourceDeviceHelper');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const { getSolarChart } = require('../../lib/charts/SolarChart');
const OpenMeteo = require('../../lib/providers/OpenMeteo');
const SolarLearningStrategy = require('../../lib/strategies/SolarLearningStrategy');
const { setTimeoutPromise } = require('../../lib/Util');

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

    // Initialize solar specific properties
    this.yieldFactors = await this.getStoreValue('yieldFactors') || new Array(96).fill(1.0);
    this.forecastData = await this.getStoreValue('forecastData') || {}; // { time: radiation }

    let history = await this.getStoreValue('powerHistory');
    if (!Array.isArray(history)) history = [];
    this.powerHistory = history
      .filter((e) => e && typeof e.time === 'number' && typeof e.power === 'number')
      .slice(-400);
    if (this.powerHistory.length !== history.length) await this.setStoreValue('powerHistory', this.powerHistory);

    this.curtailmentActive = false;

    // Start loops
    this.startForecastLoop();
    // Delay learning loop to allow source device to settle/update
    setTimeoutPromise(15000, this).then(() => {
      this.startLearningLoop();
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
    // Update learning every 5 mins
    const loop = async () => {
      if (this.isDestroyed) return;
      try {
        await this.updateLearning();
        await this.updateForecastDisplay();
      } catch (err) {
        this.error('Learning update failed:', err);
      } finally {
        if (!this.isDestroyed) {
          // Align to next 5 min slot
          const now = new Date();
          const nextSlot = new Date(now);
          nextSlot.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
          let delay = nextSlot - now;
          if (delay < 1000) delay += 5 * 60 * 1000;
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
    // Get current power (W)
    const currentPower = this.getCapabilityValue('measure_power');

    // Record history
    if (typeof currentPower === 'number') {
      const now = new Date();
      const lastEntry = this.powerHistory[this.powerHistory.length - 1];
      if (!lastEntry || (now.getTime() - lastEntry.time) > 4 * 60 * 1000) {
        this.powerHistory.push({ time: now.getTime(), power: currentPower });
        if (this.powerHistory.length > 400) this.powerHistory.shift();
        await this.setStoreValue('powerHistory', this.powerHistory);
      }
    }

    if (this.curtailmentActive) {
      this.log('Curtailment active, skipping learning');
      return;
    }

    // If capability is not set yet or invalid, skip
    if (typeof currentPower !== 'number') return;

    const result = SolarLearningStrategy.getStrategy({
      currentPower,
      forecastData: this.forecastData,
      yieldFactors: this.yieldFactors,
    });
    if (result.updated) {
      this.yieldFactors = result.yieldFactors;
      await this.setStoreValue('yieldFactors', this.yieldFactors);
      this.log(result.log);
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

    // 1. Today
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const urlToday = await getSolarChart(this.forecastData, this.yieldFactors, todayStart, todayEnd, 'Forecast Today', this.powerHistory);
    if (urlToday) {
      if (!this.solarTodayImage) {
        this.solarTodayImage = await this.homey.images.createImage();
        await this.setCameraImage('solarToday', 'Solar Today', this.solarTodayImage);
      }
      this.solarTodayImage.setStream(async (stream) => imageUrlToStream(urlToday, stream));
      await this.solarTodayImage.update();
    }

    // 2. Tomorrow
    const tomorrowStart = new Date(todayEnd);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    const urlTomorrow = await getSolarChart(this.forecastData, this.yieldFactors, tomorrowStart, tomorrowEnd, 'Forecast Tomorrow', this.powerHistory);
    if (urlTomorrow) {
      if (!this.solarTomorrowImage) {
        this.solarTomorrowImage = await this.homey.images.createImage();
        await this.setCameraImage('solarTomorrow', 'Solar Tomorrow', this.solarTomorrowImage);
      }
      this.solarTomorrowImage.setStream(async (stream) => imageUrlToStream(urlTomorrow, stream));
      await this.solarTomorrowImage.update();
    }

    // 3. Next Hours (e.g. 8 hours)
    const nextStart = new Date(now);
    const nextEnd = new Date(now);
    nextEnd.setHours(nextEnd.getHours() + 8);

    const urlNext = await getSolarChart(this.forecastData, this.yieldFactors, nextStart, nextEnd, 'Forecast Next 8h', this.powerHistory);
    if (urlNext) {
      if (!this.solarNextImage) {
        this.solarNextImage = await this.homey.images.createImage();
        await this.setCameraImage('solarNext', 'Solar Next 8h', this.solarNextImage);
      }
      this.solarNextImage.setStream(async (stream) => imageUrlToStream(urlNext, stream));
      await this.solarNextImage.update();
    }
  }

  async onUninit() {
    if (this.forecastTimeout) this.homey.clearTimeout(this.forecastTimeout);
    if (this.learningTimeout) this.homey.clearTimeout(this.learningTimeout);
    await super.onUninit();
  }

  // Override runFlowAction to handle curtailment
  async runFlowAction(id, args) {
    if (id === 'set_curtailment') {
      this.curtailmentActive = args.state;
      this.log(`Curtailment set to ${this.curtailmentActive}`);
      return Promise.resolve(true);
    }
    return super.runFlowAction(id, args);
  }

}

module.exports = SolarDevice;
