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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');

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
// p1 consumption counter (low/all tariff).
// p2 consumption counter (high tariff).
// n1 returned counter (low/all tariff).
// n2 returned counter (high tariff).
// total energy counter = p1+p2-n1-n2

class PowerDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  getActiveTariff(reading, tariff, exportTariff) {
    let activeTariff = tariff;
    const tariffType = this.getSettings().tariff_type || 'dynamic';

    if (tariffType === 'import') {
      activeTariff = tariff;
    } else if (tariffType === 'export') {
      activeTariff = exportTariff;
    } else {
      const livePower = this.getCapabilityValue(this.ds.cmap.measure_source);

      if (typeof livePower === 'number') {
        activeTariff = livePower >= 0 ? tariff : exportTariff;
      } else {
        // fallback: check meter delta
        const deltaMeter = reading.meterValue - this.meterMoney.meterValue;
        activeTariff = deltaMeter >= 0 ? tariff : exportTariff;
      }
    }
    return activeTariff;
  }

}

module.exports = PowerDevice;
