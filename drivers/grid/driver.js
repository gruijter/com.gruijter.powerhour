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

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_sum_driver');
const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');

const driverSpecifics = {
  driverId: 'grid',
  deviceCapabilities: ['measure_power.grid', 'measure_power.home',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max',
    'meter_power.grid', 'meter_power.home'],
};

class GridDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    this.startPollingEnergy().catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) EnergyPollingHelper.unregister(this.energyPollCallback);
    await super.onUninit();
  }

  async startPollingEnergy() {
    this.energyPollCallback = async (report) => {
      this.lastEnergyReport = report;
    };
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  checkDeviceCompatibility(homeyDevice) {
    const energyData = homeyDevice.energyObj || homeyDevice.energy;

    // Filter for devices that act as a cumulative main grid meter
    if (energyData && energyData.cumulative === true) {
      const hasMeterPower = homeyDevice.capabilities.some((cap) => cap.startsWith('meter_power'));
      const hasMeasurePower = homeyDevice.capabilities.includes('measure_power');
      if (hasMeterPower && hasMeasurePower) {
        return { found: true, useMeasureSource: false };
      }
    }

    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    settings.distribution = 'el_nl_2023'; // Default to a standard grid budget distribution
    return settings;
  }
}

module.exports = GridDriver;
