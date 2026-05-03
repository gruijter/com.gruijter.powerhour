/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');
const { getGridPowerFallback } = require('../../lib/Util');

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power', 'measure_watt_avg', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max',
  ],
};

class CarChargeDriver extends GenericDriver {
  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) EnergyPollingHelper.unregister(this.energyPollCallback);
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    this.energyPollCallback = async (report) => {
      let cumulativePower = getGridPowerFallback(this.homey);
      if (cumulativePower === null) cumulativePower = report?.totalCumulative?.W;

      if (Number.isFinite(cumulativePower)) {
        const devices = this.getDevices();
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;
        });
      }
    };
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  checkDeviceCompatibility(homeyDevice) {
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isEV = false;

    // Controleer op class of energy object tag volgens Homey Energy EV charger documentatie
    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isEV = true;
    } else if (energyData && energyData.isEVCharger === true) {
      isEV = true;
    }

    if (isEV) {
      const hasMeter = homeyDevice.capabilities.includes('meter_power');
      const hasMeasure = homeyDevice.capabilities.includes('measure_power');
      const useMeasureSource = !hasMeter && hasMeasure;

      if (hasMeter || hasMeasure) {
        return { found: true, useMeasureSource };
      }
    }

    return { found: false };
  }
}

module.exports = CarChargeDriver;
