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

const GenericDriver = require('../../lib/generic_sum_driver');

const driverSpecifics = {
  driverId: 'solar',
  requiredClass: 'solarpanel',
  originDeviceCapabilities: ['measure_power', 'meter_power', 'meter_power.peak', 'meter_power.consumed', 'meter_power.delivered',
    'meter_power.import', 'meter_power.total_power', 'meter_power.t1', 'meter_power.consumedL1', 'measure_energy_consumption_today'],
  sourceCapGroups: [
    {
      p1: 'meter_power.total_power', p2: null, n1: null, n2: null, // huawei solar
    },
    {
      p1: 'meter_power.t1', p2: 'meter_power.t2', n1: 'meter_power.rt1', n2: 'meter_power.rt2', // iungo
    },
    {
      p1: 'meter_power', p2: null, n1: null, n2: null, // youless
    },
    {
      p1: 'meter_power.peak', p2: 'meter_power.offPeak', n1: null, n2: null,
    },
    {
      p1: 'meter_power.consumedL1', p2: 'meter_power.consumedL2', n1: null, n2: null, // ztaz P1
    },
    {
      p1: 'meter_power.consumed', p2: null, n1: 'meter_power.generated', n2: null,
    },
    {
      p1: 'meter_power.consumed', p2: null, n1: 'meter_power.returned', n2: null,
    },
    {
      p1: 'meter_power.delivered', p2: null, n1: 'meter_power.returned', n2: null,
    },
    {
      p1: 'meter_power.import', p2: null, n1: 'meter_power.export', n2: null, // qubino
    },
    {
      p1: 'measure_energy_consumption_today', p2: null, n1: null, n2: null, // toshiba
    },
  ],
  deviceCapabilities: ['meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max',
    'measure_power', 'measure_power.forecast', 'meter_power.forecast'],
};

class SolarDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

}

module.exports = SolarDriver;
