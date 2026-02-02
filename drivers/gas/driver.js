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

const GenericDriver = require('../generic_sum_driver');

const driverSpecifics = {
  driverId: 'gas',
  originDeviceCapabilities: ['meter_gas', 'meter_gas.reading', 'meter_gas.consumed', 'meter_gas.current'],
  deviceCapabilities: ['meter_m3_last_hour', 'meter_m3_this_hour', 'meter_m3_last_day', 'meter_m3_this_day',
    'meter_m3_last_month', 'meter_m3_this_month', 'meter_m3_last_year', 'meter_m3_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_gas', 'measure_gas', 'last_minmax_reset', 'measure_lpm_min', 'measure_lpm_max'],
};

class sumDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await this.onDriverInit().catch(this.error);
  }

}

module.exports = sumDriver;
