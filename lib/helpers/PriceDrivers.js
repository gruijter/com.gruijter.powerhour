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

// An Energy Price device of this commodity in no tariff group (flows only): the likely reason a
// consumer finds no price. null: none.
const ungroupedDevice = (homey, commodity) => getDevices(homey, { commodity, driverIds: ['price'] })
  .find((d) => !Number(d.getSettings().tariff_update_group)) || null;

// Warning text when two or more price devices of this commodity send to the group, else null.
const groupConflict = (homey, commodity, group) => {
  if (!Number(group)) return null;
  const devices = getDevices(homey, { commodity }).filter((d) => Number(d.getSettings().tariff_update_group) === Number(group));
  if (devices.length < 2) return null;
  return homey.__('tariff_group_conflict', { group: String(group), sources: devices.map((d) => d.getName()).join(', ') });
};

// A flow 'Set tariff' card ran for a group a price device also feeds: { at, flows } per
// '<commodity>|<group>' (app memory). It counts while flows keep running (a daily tariff card too).
const FLOW_ACTIVE_MS = 26 * 60 * 60 * 1000;
const flowStamps = (homey) => {
  const holder = homey.app || homey;
  if (!holder.flowTariffStamps) holder.flowTariffStamps = {};
  return holder.flowTariffStamps;
};
// flows: the quoted flow names (MigrationNotice); undefined keeps the names known.
const flowTariffRan = (homey, commodity, group, flows, now = Date.now()) => {
  const key = `${commodity}|${group}`;
  const before = flowStamps(homey)[key];
  flowStamps(homey)[key] = { at: now, flows: flows === undefined ? (before && before.flows) || null : flows };
};
const flowConflict = (homey, commodity, group, now = Date.now()) => {
  if (!Number(group)) return null;
  const stamp = flowStamps(homey)[`${commodity}|${group}`];
  if (!stamp || now - stamp.at > FLOW_ACTIVE_MS) return null;
  if (!getDevices(homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === Number(group))) return null;
  return stamp.flows ? homey.__('tariff_flow_warning', { flows: stamp.flows }) : homey.__('tariff_flow_warning_unknown');
};

/**
 * The price setup warning of a device in this tariff group, else null: several price devices, a
 * flow that also sets the price, or (requirePrice) no price device at all.
 */
const priceWarning = (homey, commodity, group, requirePrice = true) => {
  if (!Number(group)) return null;
  const warning = groupConflict(homey, commodity, group) || flowConflict(homey, commodity, group);
  if (warning || !requirePrice) return warning;
  if (getDevices(homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === Number(group))) return null;
  const ungrouped = ungroupedDevice(homey, commodity);
  return ungrouped ? homey.__('warning_price_no_group', { name: ungrouped.getName(), group: Number(group) })
    : homey.__('warning_no_price_device');
};

// The Energy Price devices show a group or flow conflict as their warning (old drivers keep their migration warning).
const updateConflictWarnings = async (homey) => {
  for (const device of getDevices(homey, { driverIds: ['price'] })) {
    if (typeof device.updateGroupWarning === 'function') await device.updateGroupWarning().catch((err) => device.error(err));
  }
};

// Store value on an old device taken over by a price device (DapTakeover): its tariff group before.
const TAKEN_OVER_GROUP_KEY = 'takenOverGroup';

module.exports = {
  DRIVER_IDS,
  OLD_DRIVER_IDS,
  PRICE_LOG_CAPS,
  TAKEN_OVER_GROUP_KEY,
  isPriceDriver,
  ungroupedDevice,
  intervalOf,
  commodityOf,
  isGas,
  getDevices,
  REMOVED_EVENT,
  groupConflict,
  flowTariffRan,
  flowConflict,
  priceWarning,
  updateConflictWarnings,
  forgetGroup,
};
