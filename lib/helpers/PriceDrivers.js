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
// What a price device is (electricity, gas or water, its interval) comes from these helpers, never
// from a driver id check elsewhere.

const OLD_DRIVER_IDS = ['dap', 'dap15', 'dapg'];
const DRIVER_IDS = ['price', ...OLD_DRIVER_IDS];

const isPriceDriver = (driverId) => DRIVER_IDS.includes(driverId);

// 'power', 'gas' or 'water' (water: a fixed tariff only).
const commodityOf = (driverId, settings = {}) => {
  if (driverId === 'price') return ['gas', 'water'].includes(settings.commodity) ? settings.commodity : 'power';
  return driverId === 'dapg' ? 'gas' : 'power';
};

const isGas = (driverId, settings = {}) => commodityOf(driverId, settings) === 'gas';

// Price interval in minutes of a price device with these settings. Gas providers give hourly slots;
// water has a fixed tariff, its time of day markups are hourly.
const intervalOf = (driverId, settings = {}) => {
  if (driverId === 'price') {
    if (commodityOf(driverId, settings) !== 'power') return 60;
    return Number(settings.priceInterval) === 15 ? 15 : 60;
  }
  if (driverId === 'dap15') return 15;
  return 60;
};

// The price devices of this app (all price drivers, or driverIds), optionally of one commodity.
const getDevices = (homey, { commodity, driverIds = DRIVER_IDS } = {}) => {
  const devices = [];
  driverIds.forEach((driverId) => {
    let driver;
    try {
      driver = homey.drivers.getDriver(driverId);
    } catch {
      return; // driver not loaded
    }
    driver.getDevices().forEach((device) => {
      if (device.isDeleted) return; // still listed during onDeleted()
      if (commodity !== undefined && commodityOf(driverId, device.getSettings()) !== commodity) return;
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

// Emitted by a price device deleted or moved to another group: { commodity, group }. The consumer drivers then drop the group's
// prices when no price device is left in it (forgetGroup()).
const REMOVED_EVENT = 'price_source_removed_PBTH';

// The per-group price caches of a consumer driver (sum and bat drivers).
const GROUP_CACHES = ['tariffs', 'exportTariffs', 'priceIntervals', 'listIntervals', 'moneyUnits', 'pricesNextHours',
  'exportPricesNextHours', 'pricesNextHoursMarketLength', 'pricesNextHoursIsForecast', 'pricesStartTms'];

// Drops a group's prices from a consumer driver when the group has no price device of this commodity
// left. Not for a group last set by flow (no pricesStartTm): that tariff stays. True when dropped.
const forgetGroup = (driver, commodity, group) => {
  if (!group || !driver.pricesStartTms || !Number.isFinite(driver.pricesStartTms[group])) return false;
  if (getDevices(driver.homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === Number(group))) return false;
  GROUP_CACHES.forEach((key) => {
    if (driver[key]) delete driver[key][group];
  });
  return true;
};

// Store value on an old device taken over by a price device (DapTakeover): its tariff group before.
const TAKEN_OVER_GROUP_KEY = 'takenOverGroup';

module.exports = {
  DRIVER_IDS,
  OLD_DRIVER_IDS,
  PRICE_LOG_CAPS,
  TAKEN_OVER_GROUP_KEY,
  isPriceDriver,
  intervalOf,
  commodityOf,
  isGas,
  getDevices,
  REMOVED_EVENT,
  forgetGroup,
};
