/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const EvChargeStrategy = require('../../lib/strategies/EvChargeStrategy');
const EvFlows = require('../../lib/flows/EvFlows');

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
    measure_source: 'measure_watt_avg',
  },
};

class CarChargeDevice extends GenericDevice {
  async initDeviceValues() {
    this.lastKnownSoc = await this.getStoreValue('lastKnownSoc') || 0;
    await super.initDeviceValues();
  }

  async onInit() {
    this.ds = deviceSpecifics;
    this.flows = new EvFlows(this);
    await super.onInit().catch(this.error);

    const currentSessionId = this.sessionId;
    this.homey.setTimeout(async () => {
      await new Promise((resolve) => this.homey.setTimeout(resolve, 10000 + (Math.random() * 15000)));
      if (this.sessionId !== currentSessionId) return;
      if (this.pricesNextHours) {
        await this.updateChargeChart().catch((err) => this.error(err));
      }
    }, 0);
  }

  async addSourceCapGroup() {
    this.sourceCapGroup = {};
    const fallbackMeter = this.ds.cmap.meter_source;
    if (this.sourceDevice.capabilities.includes(fallbackMeter)) {
      this.sourceCapGroup.p1 = fallbackMeter;
    }
    if (this.sourceDevice.capabilities.includes('measure_power')) {
      this.sourceCapGroup.measure = 'measure_power';
    }
    if (this.sourceDevice.capabilities.includes('measure_battery')) {
      this.sourceCapGroup.soc = 'measure_battery';
    }
    if (!this.sourceCapGroup.p1 && !this.sourceCapGroup.measure && !this.sourceCapGroup.soc) {
      throw Error(`${this.sourceDevice.name} has no compatible meter_power, measure_power or measure_battery capabilities`);
    }
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {}
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    await this.addSourceCapGroup();
    this.log(`registering listener for ${this.sourceDevice.name}`);
    if (this.sourceCapGroup.p1) {
      this.capabilityInstances.p1 = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup.p1, async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }

    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure) {
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
        if (typeof value === 'number') {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          this.currentGridPower = value;
          // If no kWh meter, integrate Watt to kWh
          if (!this.sourceCapGroup.p1) {
            await this.updateMeterFromMeasure(-value).catch(this.error);
          }
        }
      });
    }

    if (this.sourceCapGroup.soc) {
      this.capabilityInstances.socRealtime = await this.sourceDevice.makeCapabilityInstance('measure_battery', async (value) => {
        if (typeof value === 'number') {
          const oldSoc = this.lastKnownSoc !== undefined ? this.lastKnownSoc : value;
          this.lastKnownSoc = value;
          this.setStoreValue('lastKnownSoc', this.lastKnownSoc).catch(this.error);
          // Recalculate if SoC changed by 2% or more (prevents spamming during charge)
          if (Math.abs(value - oldSoc) >= 2) {
            this.log(`EV SoC changed from ${oldSoc}% to ${value}%, recalculating strategy...`);
            if (this.socUpdateTimeout) this.homey.clearTimeout(this.socUpdateTimeout);
            this.socUpdateTimeout = this.homey.setTimeout(() => {
              this.updateChargeChart().catch(this.error);
            }, 5000);
          }
        }
      });
    }
  }

  async poll() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      return;
    }
    if (!api) return;

    if (!this.sourceCapGroup) await this.addSourceCapGroup();
    await this.getSourceDevice();

    if (this.sourceCapGroup.p1 && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup.p1]) {
      const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup.p1].value;
      await this.updateMeter(val).catch(this.error);
    }

    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_power) {
      const rtValue = this.sourceDevice.capabilitiesObj.measure_power.value;
      if (typeof rtValue === 'number') {
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        this.currentGridPower = rtValue;
        if (!this.sourceCapGroup.p1) {
          await this.updateMeterFromMeasure(-rtValue).catch(this.error);
        }
      }
    }

    if (this.sourceCapGroup.soc && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_battery) {
      const val = this.sourceDevice.capabilitiesObj.measure_battery.value;
      if (typeof val === 'number') {
        const oldSoc = this.lastKnownSoc !== undefined ? this.lastKnownSoc : val;
        if (Math.abs(val - oldSoc) >= 2) {
          this.lastKnownSoc = val;
          this.setStoreValue('lastKnownSoc', this.lastKnownSoc).catch(this.error);
          this.log(`EV SoC changed during poll from ${oldSoc}% to ${val}%, recalculating strategy...`);
          this.updateChargeChart().catch(this.error);
        } else {
          this.lastKnownSoc = val;
          this.setStoreValue('lastKnownSoc', this.lastKnownSoc).catch(this.error);
        }
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    await super.onSettings({ newSettings, changedKeys });
    const strategyKeys = ['chargePower', 'batCapacity', 'targetSoc', 'departureTime', 'variableChargePower'];
    if (changedKeys.some((k) => strategyKeys.includes(k))) {
      this.updateChargeChart().catch(this.error);
    }
    return true;
  }

  async onPricesUpdated() {
    await this.updateChargeChart().catch(this.error);
  }

  async handleUpdateMeter(reading) {
    await super.handleUpdateMeter(reading);
    const now = new Date(reading.meterTm);
    const currentSlot = (now.getUTCHours() * (60 / (this.priceInterval || 60))) + Math.floor(now.getUTCMinutes() / (this.priceInterval || 60));
    if (this.lastEvTriggerSlot !== currentSlot) {
      this.lastEvTriggerSlot = currentSlot;
      await this.updateChargeChart().catch(this.error);
    }
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    this.log('updating EV charge chart', this.getName());

    const settings = this.getSettings();
    const chargePower = settings.chargePower || 11000;
    let currentSoc = typeof this.lastKnownSoc === 'number' ? this.lastKnownSoc : 0;
    if (this.sourceCapGroup && this.sourceCapGroup.soc && this.sourceDevice && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_battery) {
      const val = this.sourceDevice.capabilitiesObj.measure_battery.value;
      if (typeof val === 'number') currentSoc = val;
    }
    this.lastKnownSoc = currentSoc;

    const strategy = EvChargeStrategy.getStrategy({
      prices: this.pricesNextHours,
      priceInterval: this.priceInterval,
      chargePower,
      currentSoc,
      targetSoc: settings.targetSoc || 100,
      batCapacity: settings.batCapacity || 50,
      departureTime: settings.departureTime || '08:00',
      timezone: this.timeZone || this.homey.clock.getTimezone(),
      variableChargePower: settings.variableChargePower || false,
    });

    if (strategy) {
      if (typeof this.flows.triggerNewEvStrategyFlow === 'function') {
        await this.flows.triggerNewEvStrategyFlow(strategy).catch(this.error);
      }

      if (this.pricesNextHoursIsForecast) {
        Object.keys(strategy).forEach((k) => {
          if (this.pricesNextHoursIsForecast[k]) strategy[k].isForecast = true;
        });
      }

      const now = new Date();
      now.setMilliseconds(0);
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone || this.homey.clock.getTimezone() }));
      const H0 = nowLocal.getHours();
      const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;

      const chartNextHours = await getChargeChart({ scheme: JSON.stringify(strategy) }, H0 + (M0 / 60), this.pricesNextHoursMarketLength, chargePower, 0, this.priceInterval, null);

      this.chartNextHoursCharge = chartNextHours;
      if (!this.nextHoursChargeImage) {
        this.nextHoursChargeImage = await this.homey.images.createImage();
        this.nextHoursChargeImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursCharge, stream, this));
        await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
      }
      await this.nextHoursChargeImage.update().catch(this.error);
    }
  }
}

module.exports = CarChargeDevice;
