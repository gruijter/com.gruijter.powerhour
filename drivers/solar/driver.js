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
    'meter_tariff', 'meter_power',
    'last_minmax_reset', 'measure_watt_max',
    'button.retrain', 'alarm_power'],
};

class SolarDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Also listen to power driver tariff events since DAP might not emit to 'solar' yet
    if (this.eventListenerTariff) {
      this.homey.on('set_tariff_power_PBTH', this.eventListenerTariff);
    }
  }

  async onUninit() {
    if (this.eventListenerTariff) {
      this.homey.removeListener('set_tariff_power_PBTH', this.eventListenerTariff);
    }
    await super.onUninit();
  }

}

module.exports = SolarDriver;
