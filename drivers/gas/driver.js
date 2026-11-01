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

const ADVANCED_IDS = ['markup_month', 'markup_day', 'markup_hour', 'decimals_meter'];

// The screens of the setup view, in order (lib/helpers/PairSetup.js).
const STEPS = [
  { id: 'meter', ids: ['homey_device_daily_reset'], roles: true },
  { id: 'price', ids: ['tariff_update_group', 'tariff', 'currency'] },
  { id: 'year', ids: [] },
  { id: 'advanced', ids: ADVANCED_IDS, optional: true },
];

const driverSpecifics = {
  driverId: 'gas',
  fallbackMeter: 'meter_gas', // a source device's primary meter, when nothing else is detected
  sourceCapGroups: [
    {
      p1: 'meter_gas.current', p2: null, n1: null, n2: null, // ZTAZ P1
    },
    {
      p1: 'meter_gas.consumed', p2: null, n1: null, n2: null,
    },
    {
      p1: 'meter_gas.reading', p2: null, n1: null, n2: null,
    },
  ],
  originDeviceCapabilities: ['meter_gas', 'meter_gas.reading', 'meter_gas.consumed', 'meter_gas.current'],
  deviceCapabilities: ['meter_m3_last_hour', 'meter_m3_this_hour', 'meter_m3_last_day', 'meter_m3_this_day',
    'meter_m3_last_month', 'meter_m3_this_month', 'meter_m3_last_year', 'meter_m3_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_gas', 'measure_gas',
    // Min/max (day, month, year - independently auto-resetting)
    'measure_lpm_min.day', 'measure_lpm_max.day',
    'measure_lpm_min.month', 'measure_lpm_max.month',
    'measure_lpm_min.year', 'measure_lpm_max.year'],
  setup: {
    settings: STEPS.flatMap((st) => st.ids),
    steps: STEPS,
    roles: [{ key: 'p1', kind: 'm3', label: 'meter' }],
    prices: 'gas',
    requirePrice: true,
  },
};

class GasDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

}

module.exports = GasDriver;
