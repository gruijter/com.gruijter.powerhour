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

const OLD_DRIVER_IDS = ['dap', 'dap15', 'dapg'];
const DRIVER_IDS = ['price', ...OLD_DRIVER_IDS];

const isPriceDriver = (driverId) => DRIVER_IDS.includes(driverId);

const commodityOf = (driverId, settings = {}) => {
  if (driverId === 'price') return ['gas', 'water'].includes(settings.commodity) ? settings.commodity : 'power';
  return driverId === 'dapg' ? 'gas' : 'power';
};

const isGas = (driverId, settings = {}) => commodityOf(driverId, settings) === 'gas';

const intervalOf = (driverId, settings = {}) => {
  if (driverId === 'price') {
    if (commodityOf(driverId, settings) !== 'power') return 60;
    return Number(settings.priceInterval) === 15 ? 15 : 60;
  }
  if (driverId === 'dap15') return 15;
  return 60;
};

const getDevices = (homey, { commodity, driverIds = DRIVER_IDS } = {}) => {
  const devices = [];
  driverIds.forEach((driverId) => {
    let driver;
    try {
      driver = homey.drivers.getDriver(driverId);
    } catch {
      return;
    }
    driver.getDevices().forEach((device) => {
      if (device.isDeleted) return;
      if (commodity !== undefined && commodityOf(driverId, device.getSettings()) !== commodity) return;
      devices.push(device);
    });
  });
  return devices;
};

const PRICE_LOG_CAPS = {
  import: ['measure_monetary.import', 'meter_price_h0'],
  export: ['measure_monetary.export', 'meter_price_h0_export'],
};

const REMOVED_EVENT = 'price_source_removed_PBTH';

const GROUP_CACHES = ['tariffs', 'exportTariffs', 'priceIntervals', 'listIntervals', 'moneyUnits', 'pricesNextHours',
  'exportPricesNextHours', 'pricesNextHoursMarketLength', 'pricesNextHoursIsForecast', 'pricesStartTms'];

const forgetGroup = (driver, commodity, group) => {
  if (!group || !driver.pricesStartTms || !Number.isFinite(driver.pricesStartTms[group])) return false;
  if (getDevices(driver.homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === Number(group))) return false;
  GROUP_CACHES.forEach((key) => {
    if (driver[key]) delete driver[key][group];
  });
  return true;
};

const ungroupedDevice = (homey, commodity) => getDevices(homey, { commodity, driverIds: ['price'] })
  .find((d) => !Number(d.getSettings().tariff_update_group)) || null;

const groupConflict = (homey, commodity, group) => {
  if (!Number(group)) return null;
  const devices = getDevices(homey, { commodity }).filter((d) => Number(d.getSettings().tariff_update_group) === Number(group));
  if (devices.length < 2) return null;
  return homey.__('tariff_group_conflict', { group: String(group), sources: devices.map((d) => d.getName()).join(', ') });
};

const FLOW_ACTIVE_MS = 26 * 60 * 60 * 1000;
const flowStamps = (homey) => {
  const holder = homey.app || homey;
  if (!holder.flowTariffStamps) holder.flowTariffStamps = {};
  return holder.flowTariffStamps;
};
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

const tariffScanState = (homey) => {
  const holder = homey.app || homey;
  if (!holder.tariffFlowScan) holder.tariffFlowScan = { at: 0, result: null, running: null };
  return holder.tariffFlowScan;
};

const flowFed = (homey, commodity, group, now = Date.now()) => {
  const stamp = flowStamps(homey)[`${commodity}|${group}`];
  if (stamp && now - stamp.at <= FLOW_ACTIVE_MS) return true;
  const { result } = tariffScanState(homey);
  const names = result && result[commodity] && result[commodity][Number(group)];
  return !!(names && names.length);
};

const priceWarning = (homey, commodity, group, requirePrice = true) => {
  if (!Number(group)) return null;
  const warning = groupConflict(homey, commodity, group) || flowConflict(homey, commodity, group);
  if (warning || !requirePrice) return warning;
  if (getDevices(homey, { commodity }).some((d) => Number(d.getSettings().tariff_update_group) === Number(group))) return null;
  if (flowFed(homey, commodity, group)) return null;
  const ungrouped = ungroupedDevice(homey, commodity);
  return ungrouped ? homey.__('warning_price_no_group', { name: ungrouped.getName(), group: Number(group) })
    : homey.__('warning_no_price_device');
};

const updateConflictWarnings = async (homey) => {
  for (const device of getDevices(homey, { driverIds: ['price'] })) {
    if (typeof device.updateGroupWarning === 'function') await device.updateGroupWarning().catch((err) => device.error(err));
  }
};

const MAX_GROUP = 10;
const METER_DRIVER_IDS = {
  power: ['power', 'grid', 'solar', 'battery', 'evCharger'],
  gas: ['gas'],
  water: ['water'],
};
const nextGroup = (homey, commodity) => {
  const used = [...getDevices(homey, { commodity }), ...getDevices(homey, { driverIds: METER_DRIVER_IDS[commodity] || [] })]
    .map((d) => Number(d.getSettings().tariff_update_group) || 0);
  const next = Math.max(0, ...used) + 1;
  return next <= MAX_GROUP ? next : null;
};

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
  nextGroup,
  METER_DRIVER_IDS,
  REMOVED_EVENT,
  groupConflict,
  flowTariffRan,
  flowConflict,
  priceWarning,
  flowFed,
  tariffScanState,
  updateConflictWarnings,
  forgetGroup,
};
