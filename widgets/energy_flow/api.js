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

const devicesOf = (homey, driverId) => {
  try {
    return homey.drivers.getDriver(driverId).getDevices();
  } catch {
    return [];
  }
};

const socOf = (devices) => {
  const socs = devices.map((d) => d.soc).filter((s) => typeof s === 'number');
  return socs.length ? Math.round(socs.reduce((a, b) => a + b, 0) / socs.length) : null;
};

// W, signed as on the Grid Monitor: grid + import, battery + charging, EV + charging.
module.exports = {
  async getFlow({ homey }) {
    const grid = devicesOf(homey, 'grid')[0];
    if (!grid) return { grid: null };
    const val = (cap) => Math.round(grid.getCapabilityValue(cap) || 0);
    const gridW = val('measure_watt_grid');
    const solarW = Math.max(0, val('measure_watt_solar'));
    const batteryW = val('measure_watt_battery');
    const evW = Math.max(0, val('measure_watt_evcharger'));
    const batteries = devicesOf(homey, 'battery');
    const evs = devicesOf(homey, 'evCharger');
    const report = grid.driver && grid.driver.lastEnergyReport;
    const hasSolar = devicesOf(homey, 'solar').length > 0
      || !!(report && report.totalGenerated && typeof report.totalGenerated.W === 'number');
    return {
      grid: gridW,
      solar: hasSolar ? solarW : null,
      battery: batteries.length ? batteryW : null,
      batterySoc: socOf(batteries),
      ev: evs.length ? evW : null,
      evSoc: evs.length === 1 ? socOf(evs) : null,
      // Unsmoothed balance, so the flows add up; timing skew can make it negative.
      home: Math.max(0, gridW + solarW - batteryW - evW),
    };
  },
};
