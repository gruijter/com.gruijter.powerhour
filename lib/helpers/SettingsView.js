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

const PairSetup = require('./PairSetup');
const MoneyUnit = require('./MoneyUnit');
const BudgetSetup = require('./BudgetSetup');

const PREFIX = 'view_';
const OWN_LABELS = ['price_info', 'budget_info', 'biddingZone', 'description', 'formulaInUse', 'export_formulaInUse'];
const PRICE_IDS = ['tariff_update_group', 'tariff', 'tariff_export', 'currency'];
const MONEY_IDS = ['markup_month', 'markup_day', 'markup_hour', 'wearCost', 'minProfit', 'wearPurchasePrice', 'cheapPrice',
  'maxPrice', 'peakPrice', 'fixedMarkup', 'tax', 'fixedMarkupWeekend', 'export_fixedMarkup', 'export_tax',
  'export_fixedMarkupWeekend', 'export_floorMin'];
const SOURCE_IDS = ['source_device_type', 'homey_device_id'];
const UNITS = { connectionAmps: 'A', connectionVoltage: 'V', fuseMarginPct: '%' };
const PRICE_GROUPS = [
  {
    id: 'price_type',
    ids: ['commodity', 'tariffType', 'description', 'biddingZone', 'priceInterval', 'currency', 'fetchExchangeRate', 'exchangeRate',
      'moneyDecimals', 'tariff_update_group'],
  },
  { id: 'import', ids: ['vat', 'fixedMarkup', 'variableMarkup', 'tax', 'fixedMarkupTOD', 'fixedMarkupWeekend', 'marketFloor', 'formulaInUse'] },
  {
    id: 'export',
    ids: ['export_vat', 'export_fixedMarkup', 'export_variableMarkup', 'export_tax', 'export_fixedMarkupTOD', 'export_fixedMarkupWeekend',
      'export_floor', 'export_floorMin', 'export_floorPercent', 'export_floorBase', 'export_show_chart_line', 'export_formulaInUse'],
  },
  {
    id: 'advanced',
    ids: ['priceProvider', 'entsoeApiKey', 'forecastEnable', 'variableMarkupAbsPrice', 'export_variableMarkupAbsPrice', 'decimals', 'priceLevelHours'],
  },
];

const viewId = (id) => (OWN_LABELS.includes(id) ? id : `${PREFIX}${id}`);

const groupsFor = (driverId, steps) => {
  if (driverId === 'price') return PRICE_GROUPS.map((g) => ({ ...g, roles: false }));
  return (steps || []).map((st) => {
    if (st.id === 'year') return { id: 'year', roles: false, ids: ['budget_info'] };
    const ids = [];
    (st.ids || []).forEach((id) => {
      const shown = PRICE_IDS.includes(id) ? 'price_info' : id;
      if (!ids.includes(shown)) ids.push(shown);
    });
    return { id: st.id, roles: !!st.roles, ids };
  }).filter((g) => g.ids.length || g.roles);
};

const valueOf = (settings, defs, id) => (settings[id] !== undefined ? settings[id] : (defs[id] || {}).value);

const applies = (device, settings, defs, def, depth = 0) => {
  const cond = def && def.showIf;
  if (!cond || depth > 5) return true;
  if (cond.role) {
    const used = typeof device.roleUsed === 'function' ? device.roleUsed(cond.role) : null;
    return used !== false;
  }
  if (!defs[cond.id]) return false;
  const v = String(valueOf(settings, defs, cond.id));
  let ok = true;
  if (cond.value !== undefined) ok = v === String(cond.value);
  else if (cond.not !== undefined) ok = v !== String(cond.not);
  else if (Array.isArray(cond.values)) ok = cond.values.map(String).includes(v);
  return ok && applies(device, settings, defs, defs[cond.id], depth + 1);
};

const currencyOf = (device) => (device.driver.ds.driverId === 'price'
  ? (device.getSettings().currency || '€') : MoneyUnit.get(device, '').currency);

const textOf = (device, defs, settings, id) => {
  const { homey } = device;
  const def = defs[id];
  if (!def || !applies(device, settings, defs, def)) return '-';
  const raw = valueOf(settings, defs, id);
  const v = device.driver.viewValue ? device.driver.viewValue(id, settings, raw) : raw;
  if (v === undefined || v === null || v === '') return '-';
  let text;
  if (def.type === 'checkbox') {
    text = homey.__(v === true || v === 'true' ? 'settings_view.on' : 'settings_view.off');
  } else if (def.type === 'dropdown') {
    const opt = (def.values || []).find((o) => String(o.id) === String(v));
    text = opt ? PairSetup.text(homey, opt.label) : String(v);
  } else if (def.type === 'daymonth') {
    text = BudgetSetup.dateText(homey, BudgetSetup.validStartDate(v) || '0101');
  } else if (id === 'entsoeApiKey') {
    text = `••••${String(v).slice(-4)}`;
  } else {
    text = String(v);
    if (MONEY_IDS.includes(id)) text = `${currencyOf(device)} ${text}`.trim();
    if (UNITS[id]) text += ` ${UNITS[id]}`;
  }
  const vatId = `${id}InclVat`;
  if (defs[vatId]) text += ` (${homey.__(valueOf(settings, defs, vatId) ? 'price_setup.vat_incl' : 'price_setup.vat_excl')})`;
  return text;
};

const viewIds = (driver) => groupsFor(driver.ds.driverId, driver.ds.setup && driver.ds.setup.steps)
  .flatMap((g) => g.ids).filter((id) => !OWN_LABELS.includes(id));

const update = async (device) => {
  const { driver } = device;
  if (!driver || !driver.ds || (!driver.ds.setup && driver.ds.driverId !== 'price')) return;
  if (!driver.settingsViewDefs) driver.settingsViewDefs = PairSetup.settingDefs(driver);
  const defs = driver.settingsViewDefs;
  const settings = device.getSettings();
  const out = {};
  viewIds(driver).forEach((id) => {
    const text = textOf(device, defs, settings, id);
    if (settings[viewId(id)] !== text) out[viewId(id)] = text;
  });
  if (Object.keys(out).length) await device.setSettings(out);
};

const afterSet = async (device, settings) => {
  const { driver } = device;
  if (!driver || !driver.ds || (!driver.ds.setup && driver.ds.driverId !== 'price')) return;
  if (!driver.settingsViewDefs) driver.settingsViewDefs = PairSetup.settingDefs(driver);
  const defs = driver.settingsViewDefs;
  const counts = (k) => SOURCE_IDS.includes(k) || (defs[k] && defs[k].type !== 'label' && !OWN_LABELS.includes(k));
  if (!Object.keys(settings || {}).some(counts)) return;
  await update(device);
};

module.exports = {
  PREFIX,
  OWN_LABELS,
  groupsFor,
  viewId,
  textOf,
  update,
  afterSet,
};
