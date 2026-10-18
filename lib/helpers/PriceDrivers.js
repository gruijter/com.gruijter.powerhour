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

// The price drivers: the generic 'price' driver and the deprecated dap (60m), dap15 and dapg (gas).
// What a price device is (gas or electricity, its interval) comes from these helpers, never from a
// driver id check elsewhere.

const DRIVER_IDS = ['price', 'dap', 'dap15', 'dapg'];

const isPriceDriver = (driverId) => DRIVER_IDS.includes(driverId);

// Price interval in minutes of a price device with these settings.
const intervalOf = (driverId, settings = {}) => {
  if (driverId === 'price') return [15, 30, 60].includes(Number(settings.priceInterval)) ? Number(settings.priceInterval) : 60;
  if (driverId === 'dap15') return 15;
  return 60;
};

const isGas = (driverId, settings = {}) => {
  if (driverId === 'price') return settings.commodity === 'gas';
  return driverId === 'dapg';
};

// The price devices of this app (all price drivers), optionally only gas or only electricity.
const getDevices = (homey, { gas } = {}) => {
  const devices = [];
  DRIVER_IDS.forEach((driverId) => {
    let driver;
    try {
      driver = homey.drivers.getDriver(driverId);
    } catch {
      return; // driver not loaded
    }
    driver.getDevices().forEach((device) => {
      if (gas !== undefined && isGas(driverId, device.getSettings()) !== gas) return;
      devices.push(device);
    });
  });
  return devices;
};

// The Insights capabilities of the import and export price now, of all price drivers.
const PRICE_LOG_CAPS = {
  import: ['measure_monetary.import', 'meter_price_h0'],
  export: ['measure_monetary.export', 'meter_price_h0_export'],
};

module.exports = {
  DRIVER_IDS,
  PRICE_LOG_CAPS,
  isPriceDriver,
  intervalOf,
  isGas,
  getDevices,
};
