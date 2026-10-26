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

const MoneyUnit = require('./MoneyUnit');

// Repair "Fix totals or costs" (drivers/<id>/repair/fix_values.html, lib/helpers/PairSetup.js).
// A device offers it with fixValues() -> { kinds: [{ id, label, fields: [{ id, label, value, unit }] }] }
// and applyFixValues({ kind, values: { fieldId: value } }), values holding only the changed fields.

const MONEY = {
  day: 'meter_money_this_day',
  month: 'meter_money_this_month',
  year: 'meter_money_this_year',
  lastDay: 'meter_money_last_day',
  lastMonth: 'meter_money_last_month',
  lastYear: 'meter_money_last_year',
};

const LABELS = {
  day: 'repair.fix_this_day',
  month: 'repair.fix_this_month',
  year: 'repair.fix_this_year',
  lastDay: 'repair.fix_last_day',
  lastMonth: 'repair.fix_last_month',
  lastYear: 'repair.fix_last_year',
};

const round = (value, decimals) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

const text = (homey, t) => {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t[homey.i18n.getLanguage() || 'en'] || t.en || '';
};

// The unit of a capability: the device's own options, else the manifest's (getCapabilityOptions()
// throws for a capability without options of its own, skill section 18).
const unitOf = (device, cap) => {
  let units;
  try {
    ({ units } = device.getCapabilityOptions(cap));
  } catch {
    units = undefined;
  }
  if (!units) ({ units } = device.homey.app.manifest.capabilities[cap] || {});
  return text(device.homey, units);
};

/**
 * One field to correct, labelled by period (LABELS) or by a translation key.
 * @returns {{ id: string, label: string, value: number|string, unit: string }}
 */
const field = (device, id, value, unit, decimals, label = LABELS[id]) => ({
  id, label: device.homey.__(label), value: round(value, decimals), unit,
});

// The money capabilities this device has, as a kind, or null.
const moneyKind = (device) => {
  const { currency, decimals } = MoneyUnit.get(device);
  const fields = Object.entries(MONEY).filter(([, cap]) => device.hasCapability(cap))
    .map(([id, cap]) => field(device, id, device.getCapabilityValue(cap), currency, decimals));
  return fields.length ? { id: 'money', label: device.homey.__('repair.fix_money'), fields } : null;
};

/**
 * The changed values as numbers, for the allowed field ids only ("7,5" is 7.5).
 * @throws when a value is not a number
 */
const parse = (device, values = {}, ids = []) => {
  const out = {};
  Object.keys(values).filter((id) => ids.includes(id)).forEach((id) => {
    const num = Number(String(values[id]).trim().replace(',', '.'));
    if (String(values[id]).trim() === '' || !Number.isFinite(num)) throw Error(device.homey.__('error_value_not_number'));
    out[id] = num;
  });
  return out;
};

module.exports = {
  MONEY,
  field,
  unitOf,
  moneyKind,
  parse,
};
