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
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'solar',
  requiredClass: 'solarpanel',
  deviceCapabilities: ['measure_power', 'measure_watt_forecast.h0',
    'measure_watt_forecast.m15', 'measure_watt_forecast.m30',
    'measure_watt_forecast.m45', 'measure_watt_forecast.h1',
    'measure_watt_forecast.h2', 'measure_watt_forecast.h3',
    'meter_kwh_this_hour', 'meter_kwh_forecast.h0',
    'meter_kwh_this_day', 'meter_kwh_forecast.this_day',
    'measure_watt_forecast.tomorrow_peak', 'meter_kwh_forecast.tomorrow',
    'meter_kwh_last_hour', 'meter_kwh_last_day',
    'meter_kwh_last_month', 'meter_kwh_this_month',
    'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour',
    'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month',
    'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'measure_solar_use.this_hour', 'measure_solar_use.this_day',
    'measure_solar_use.this_month', 'measure_solar_use.this_year',
    'meter_tariff', 'meter_power',
    // Max (day, month, year - independently auto-resetting). No min: solar's production floor
    // is trivially ~0 at night, deliberately not tracked (see grid's driver.js for the
    // symmetric min+max version used by drivers where min is meaningful).
    'measure_watt_max.day', 'measure_watt_max.month', 'measure_watt_max.year',
    'button.retrain', 'alarm_power'],
};

class SolarDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Only initialize polling if there are devices.
    // If a device is paired later, checkStartPolling will handle it.
    if (this.getDevices().length > 0) {
      await this.checkStartPolling();
    }
  }

  async checkStartPolling() {
    if (this.energyPollCallback) return; // Already polling
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    await this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    this.energyPollCallback = async (report) => {
      // eslint-disable-next-line global-require
      const { getGridPowerFallback } = require('../../lib/helpers/Util');
      let cumulativePower = getGridPowerFallback(this.homey);
      if (cumulativePower === null) cumulativePower = report?.totalCumulative?.W;

      if (Number.isFinite(cumulativePower)) {
        const devices = this.getDevices();

        // 1. Calculate total solar power across the whole house
        let totalSolarPower = 0;
        devices.forEach((device) => {
          const power = device.getCapabilityValue('measure_power') || 0;
          if (power > 0) totalSolarPower += power;
        });

        // 2. Assign values and calculate proportional self-consumption
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;

          const power = device.getCapabilityValue('measure_power') || 0;
          if (power <= 0) {
            device.currentSelfConsumedPower = 0;
          } else if (cumulativePower >= 0) {
            device.currentSelfConsumedPower = power;
          } else {
            const exportPower = Math.abs(cumulativePower);
            const deviceRatio = power / totalSolarPower;
            const deviceExport = exportPower * deviceRatio;
            device.currentSelfConsumedPower = Math.max(0, power - deviceExport);
          }
        });
      }
    };
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

}

module.exports = SolarDriver;
