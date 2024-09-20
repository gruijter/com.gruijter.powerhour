/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const GenericDriver = require('../generic_bat_driver');

const driverSpecifics = {
  driverId: 'battery',
  originDeviceCapabilities: ['measure_battery', 'measure_power.battery', 'measure_power.battery1'],
  sourceCapGroups: [
    {
      soc: 'measure_battery', productionPower: 'measure_power', chargeMode: 'charge_mode', // Sessy
    },
    {
      soc: 'measure_battery_soc', usagePower: 'measure_battery_power', // Solax
    },
    {
      soc: 'battery_capacity', usagePower: 'measure_power.battery', // Victron
    },
    {
      soc: 'measure_battery', productionPower: 'measure_power.batt_in', usagePower: 'measure_power.batt_out', // Sonnen
    },
    {
      soc: 'measure_battery', productionPower: 'from_battery_capability', usagePower: 'to_battery_capability', // Sonnen Batterie
    },
    {
      soc: 'measure_percentage.bat_soc', productionPower: 'measure_power.battery', // Blauhoff Afore
    },
    {
      soc: 'measure_percentage.battery1', productionPower: 'measure_power.battery1', // Blauhoff Deye
    },
  ],
  deviceCapabilities: [
    'measure_watt_avg', 'meter_kwh_stored',
    'meter_kwh_charging', 'meter_kwh_discharging',
    'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month',
    'meter_money_last_year', 'meter_money_this_year',
    'meter_tariff',
    'meter_power_hidden',
    // 'roi_duration', // added only for HP2023
  ],
};

class sumDriver extends GenericDriver {

  async onInit() {
    // this.log('driver onInit');
    this.ds = driverSpecifics;
    await this.onDriverInit().catch(this.error);
  }

}

module.exports = sumDriver;
