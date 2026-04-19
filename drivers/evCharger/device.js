/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const EvChargeStrategy = require('../../lib/strategies/EvChargeStrategy');

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
  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }) {
    await super.onSettings({ newSettings, changedKeys });
    const strategyKeys = ['chargePower', 'batCapacity', 'targetSoc', 'departureTime'];
    if (changedKeys.some((k) => strategyKeys.includes(k))) {
      this.updateChargeChart().catch(this.error);
    }
    return true;
  }

  async updateTariffHistory(tariff, currentTm, priceInterval, exportTariff, args) {
    await super.updateTariffHistory(tariff, currentTm, priceInterval, exportTariff);
    if (args && args.pricesNextHours) {
      this.pricesNextHours = args.pricesNextHours;
      this.pricesNextHoursMarketLength = args.pricesNextHoursMarketLength || 24;
      this.priceInterval = args.priceInterval || 60;
      await this.updateChargeChart().catch(this.error);
    }
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    this.log('updating EV charge chart', this.getName());

    const settings = this.getSettings();
    const chargePower = settings.chargePower || 11000;
    const currentSoc = this.hasCapability('measure_battery') ? (this.getCapabilityValue('measure_battery') || 0) : 0;

    const strategy = EvChargeStrategy.getStrategy({
      prices: this.pricesNextHours,
      priceInterval: this.priceInterval,
      chargePower,
      currentSoc,
      targetSoc: settings.targetSoc || 100,
      batCapacity: settings.batCapacity || 50,
      departureTime: settings.departureTime || '08:00',
      timezone: this.timeZone || this.homey.clock.getTimezone(),
    });

    if (strategy) {
      const now = new Date();
      now.setMilliseconds(0);
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone || this.homey.clock.getTimezone() }));
      const H0 = nowLocal.getHours();
      const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;

      const chartNextHours = await getChargeChart(strategy, H0 + (M0 / 60), this.pricesNextHoursMarketLength, chargePower, 0, this.priceInterval, this.pricesNextHours);

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
