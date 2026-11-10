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

// The settings chosen in the (re)pair setup view, read-only on the device's settings page: one label
// setting view_<id> per setting, grouped as the setup steps. The manifest part is made by
// test/tools/settingsView.js from groupsFor(); update() writes the values.

const PairSetup = require('./PairSetup');
const MoneyUnit = require('./MoneyUnit');

const PREFIX = 'view_';
// Shown by their own label settings (written elsewhere), not as view_<id>.
const OWN_LABELS = ['price_info', 'budget_info', 'biddingZone', 'description', 'formulaInUse', 'export_formulaInUse'];
// The tariff group, fixed tariff and its currency are price_info together.
const PRICE_IDS = ['tariff_update_group', 'tariff', 'tariff_export', 'currency'];
// Amounts of money: with the currency.
const MONEY_IDS = ['markup_month', 'markup_day', 'markup_hour', 'wearCost', 'minProfit', 'wearPurchasePrice', 'cheapPrice',
  'maxPrice', 'peakPrice', 'fixedMarkup', 'tax', 'fixedMarkupWeekend', 'export_fixedMarkup', 'export_tax',
  'export_fixedMarkupWeekend', 'export_floorMin'];
// Units the label does not hold.
const UNITS = { connectionAmps: 'A', connectionVoltage: 'V', fuseMarginPct: '%' };
// The Energy Price device: the fields of its own setup view.
const PRICE_GROUPS = [
  {
    id: 'price_type',
    ids: ['commodity', 'tariffType', 'description', 'biddingZone', 'priceInterval', 'currency', 'fetchExchangeRate', 'exchangeRate',
      'moneyDecimals', 'tariff_update_group'],
  },
  { id: 'import', ids: ['vat', 'fixedMarkup', 'variableMarkup', 'tax', 'fixedMarkupTOD', 'fixedMarkupWeekend', 'formulaInUse'] },
  {
    id: 'export',
    ids: ['export_vat', 'export_fixedMarkup', 'export_variableMarkup', 'export_tax', 'export_fixedMarkupTOD', 'export_fixedMarkupWeekend',
      'export_floor', 'export_floorMin', 'export_floorPercent', 'export_floorBase', 'export_show_chart_line', 'export_formulaInUse'],
  },
  {
    id: 'advanced',
    ids: ['priceProvider', 'entsoeApiKey', 'forecastEnable', 'variableMarkupAbsPrice', 'export_variableMarkupAbsPrice', 'decimals'],
  },
];

const viewId = (id) => (OWN_LABELS.includes(id) ? id : `${PREFIX}${id}`);

/**
 * The groups of the settings page, in the order of the setup steps: { id, roles, ids }. roles: the
 * step that picks the source device (its group also holds the source device labels).
 */
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

// A setting's value, or its default.
const valueOf = (settings, defs, id) => (settings[id] !== undefined ? settings[id] : (defs[id] || {}).value);

// showIf (PairSetup) met, its parents too. A role (source capability) counts as met.
const applies = (settings, defs, def, depth = 0) => {
  const cond = def && def.showIf;
  if (!cond || cond.role || depth > 5) return true;
  const v = String(valueOf(settings, defs, cond.id));
  let ok = true;
  if (cond.value !== undefined) ok = v === String(cond.value);
  else if (cond.not !== undefined) ok = v !== String(cond.not);
  else if (Array.isArray(cond.values)) ok = cond.values.map(String).includes(v);
  return ok && applies(settings, defs, defs[cond.id], depth + 1);
};

const currencyOf = (device) => (device.driver.ds.driverId === 'price'
  ? (device.getSettings().currency || '€') : MoneyUnit.get(device, '').currency);

/** The text of one setting: '-' when not set or not used. */
const textOf = (device, defs, settings, id) => {
  const { homey } = device;
  const def = defs[id];
  if (!def || !applies(settings, defs, def)) return '-';
  const raw = valueOf(settings, defs, id);
  // A driver can show what is in effect (e.g. a mode that needs a source device).
  const v = device.driver.viewValue ? device.driver.viewValue(id, settings, raw) : raw;
  if (v === undefined || v === null || v === '') return '-';
  let text;
  if (def.type === 'checkbox') {
    text = homey.__(v === true || v === 'true' ? 'settings_view.on' : 'settings_view.off');
  } else if (def.type === 'dropdown') {
    const opt = (def.values || []).find((o) => String(o.id) === String(v));
    text = opt ? PairSetup.text(homey, opt.label) : String(v);
  } else if (id === 'entsoeApiKey') {
    text = `••••${String(v).slice(-4)}`;
  } else {
    text = String(v);
    if (MONEY_IDS.includes(id)) text = `${currencyOf(device)} ${text}`.trim();
    if (UNITS[id]) text += ` ${UNITS[id]}`;
  }
  // A price field with its VAT checkbox: one line.
  const vatId = `${id}InclVat`;
  if (defs[vatId]) text += ` (${homey.__(valueOf(settings, defs, vatId) ? 'price_setup.vat_incl' : 'price_setup.vat_excl')})`;
  return text;
};

const viewIds = (driver) => groupsFor(driver.ds.driverId, driver.ds.setup && driver.ds.setup.steps)
  .flatMap((g) => g.ids).filter((id) => !OWN_LABELS.includes(id));

/** Writes the view_<id> labels that changed. */
const update = async (device) => {
  const { driver } = device;
  if (!driver || !driver.ds || (!driver.ds.setup && driver.ds.driverId !== 'price')) return;
  // The definitions do not change while the app runs.
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

/** After device.setSettings(): the labels follow a changed setting (not a label itself). */
const afterSet = async (device, settings) => {
  const keys = Object.keys(settings || {});
  if (!keys.length || keys.every((k) => k.startsWith(PREFIX) || OWN_LABELS.includes(k))) return;
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
