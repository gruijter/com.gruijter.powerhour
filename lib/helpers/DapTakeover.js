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

// TEMPORARY: taking over a deprecated dap / dap15 / dapg device when pairing a price device
// (called from PriceSetup.js and drivers/price/device.js); MigrationNotice.js is the other half.
// Remove this file and its calls (search 'DapTakeover') once the old DAP drivers are gone.

const PairSetup = require('./PairSetup');

// Taking over a deprecated dap / dap15 / dapg device: '<driverId>|<data id>'.
const OLD_DRIVERS = ['dap', 'dap15', 'dapg'];
const oldDevice = (driver, key) => {
  const [driverId, id] = String(key || '').split('|');
  if (!OLD_DRIVERS.includes(driverId)) return null;
  try {
    return driver.homey.drivers.getDriver(driverId).getDevices().find((d) => d.getData().id === id) || null;
  } catch {
    return null;
  }
};

// Energy and tariff type of an old device: a fixed tariff ignores the market price (import and export).
const oldType = (driverId, s) => {
  const gas = driverId === 'dapg';
  const fixed = gas ? !!s.ignore_market_price : !!(s.ignore_market_price && s.export_ignore_market_price);
  return { commodity: gas ? 'gas' : 'power', tariffType: fixed ? 'fixed' : 'dynamic' };
};

const oldDevices = (driver) => OLD_DRIVERS.flatMap((driverId) => {
  try {
    return driver.homey.drivers.getDriver(driverId).getDevices()
      .map((d) => ({ key: `${driverId}|${d.getData().id}`, name: d.getName(), ...oldType(driverId, d.getSettings()) }));
  } catch {
    return [];
  }
});

/**
 * The view's values from an old device, giving the same prices: its amounts included VAT (the old
 * hint), so VAT 0 and all amounts 'incl. VAT'. An ignored market price becomes a -100% markup on it
 * (none for a fixed tariff, where the % applies to the supply price).
 */
const importValues = (dap) => {
  const driverId = dap.driver.id;
  const s = dap.getSettings();
  const type = oldType(driverId, s);
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const values = {
    ...type,
    biddingZone: s.biddingZone,
    priceInterval: driverId === 'dap15' ? '15' : '60',
    currency: s.currency || '€',
    fetchExchangeRate: s.fetchExchangeRate || 'NONE',
    tariff_update_group: num(s.tariff_update_group),
    name: dap.getName(),
  };
  (type.commodity === 'gas' ? [''] : ['', 'export_']).forEach((prefix) => {
    let percent = num(s[`${prefix}variableMarkup`]);
    if (s[`${prefix}ignore_market_price`]) percent = type.tariffType === 'fixed' ? 0 : -100;
    Object.assign(values, {
      [`${prefix}vat`]: 0,
      [`${prefix}tax`]: 0,
      [`${prefix}variableMarkup`]: percent,
      [`${prefix}fixedMarkup`]: num(s[`${prefix}fixedMarkup`]),
      [`${prefix}fixedMarkupInclVat`]: true,
      [`${prefix}fixedMarkupTOD`]: s[`${prefix}fixedMarkupTOD`] || '',
      [`${prefix}fixedMarkupTODInclVat`]: true,
      [`${prefix}fixedMarkupWeekend`]: num(s[`${prefix}fixedMarkupWeekend`]),
      [`${prefix}fixedMarkupWeekendInclVat`]: true,
    });
  });
  return values;
};

// Settings of an old device that the view does not ask, for the new device.
const importExtras = (driver, dap) => {
  const s = dap.getSettings();
  const defs = PairSetup.settingDefs(driver);
  const extras = {};
  ['decimals', 'exchangeRate', 'entsoeApiKey', 'forecastEnable', 'export_show_chart_line'].forEach((id) => {
    if (s[id] !== undefined && defs[id]) extras[id] = s[id];
  });
  ['', 'export_'].forEach((prefix) => {
    const id = `${prefix}variableMarkupAbsPrice`;
    if (s[id] !== undefined && !s[`${prefix}ignore_market_price`]) extras[id] = s[id];
  });
  if ((defs.priceProvider.values || []).some((v) => v.id === s.priceProvider)) extras.priceProvider = s.priceProvider;
  return extras;
};

// The month averages of an old device, for the new device's first init (PriceDevice). With the
// day and month they were last updated, so the rolling average continues instead of restarting.
const importStore = (dap) => {
  const thisMonth = dap.getCapabilityValue('meter_price_this_month_avg');
  if (!Number.isFinite(thisMonth)) return {};
  const lastMonth = dap.getCapabilityValue('meter_price_last_month_avg');
  return {
    takeoverMonthAvg: { thisMonth, lastMonth: Number.isFinite(lastMonth) ? lastMonth : null },
    lastDayNumber: dap.getStoreValue('lastDayNumber'),
    lastMonthNumber: dap.getStoreValue('lastMonthNumber'),
  };
};

// Pair session part (PriceSetup.registerPair()): the view's 'setup_import' and 'setup_imported',
// and for 'setup_set' the extra settings and store of the device taken over (none: empty).
const pairSession = (driver, session) => {
  let imported = null;
  let newName = '';
  session.setHandler('setup_import', async (key) => {
    const dap = oldDevice(driver, key);
    if (!dap) throw Error(driver.homey.__('error_device_not_found'));
    return importValues(dap);
  });
  // After the new device is created: the old one no longer sends its price to the group.
  session.setHandler('setup_imported', async () => {
    if (!imported) return;
    driver.log(`${imported.getName()} taken over: tariff group set to 0`);
    await imported.setSettings({ tariff_update_group: 0 });
    imported.settings = imported.getSettings();
    const notice = driver.homey.app.migrationNotice;
    if (notice) await notice.takenOver(imported, newName).catch((err) => driver.error(err));
  });
  return {
    select(key, name) {
      imported = key ? oldDevice(driver, key) : null;
      newName = name || '';
    },
    settings: () => (imported ? importExtras(driver, imported) : {}),
    store: () => (imported ? importStore(imported) : {}),
  };
};

// Price device onInit: the month averages of the device it took over (importStore()), once.
const applyMonthAvg = async (device) => {
  const avg = device.getStoreValue('takeoverMonthAvg');
  if (!avg) return;
  const caps = device.monthAvgCaps();
  for (const key of ['thisMonth', 'lastMonth']) {
    if (Number.isFinite(avg[key]) && device.hasCapability(caps[key])) await device.setCapabilityValue(caps[key], avg[key]);
  }
  await device.unsetStoreValue('takeoverMonthAvg');
  device.log('Month averages taken over', avg);
};

module.exports = {
  oldDevices,
  pairSession,
  applyMonthAvg,
};
