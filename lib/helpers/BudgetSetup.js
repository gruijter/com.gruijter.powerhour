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

// Year start and budget: app-managed settings (not in the manifest, skill section 22), set in the
// setup view at pairing and in the repair view "Year budget". The settings page only shows a
// summary label (budget_info).

const Budget = require('../Budget');
const ClimateProfile = require('../ClimateProfile');
const ClimateNormals = require('./ClimateNormals');

const UNITS = {
  grid: 'kWh', power: 'kWh', solar: 'kWh', evCharger: 'kWh', gas: 'm³', water: 'm³',
};
const HEATING = { electricity: ['none', 'heat_pump', 'hybrid', 'electric'], gas: ['boiler', 'hybrid', 'none'] };
const DEFAULTS = {
  start_date: '0101', budget: '0', distribution: 'linear', budget_heating: { electricity: 'none', gas: 'boiler' }, budget_cooling: false,
};
const REGIONAL = ['el_nl_2023', 'gas_nl_2023', 'pv_52n_t40s'];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// New devices: a year budget from the start where it is usual, a typical value to adjust. Solar
// without a value: estimated from the peak power and the location (solarEstimate).
const PAIR_PRESETS = {
  grid: { budget: '2500', distribution: 'local' },
  gas: { budget: '1100', distribution: 'local' },
  water: { budget: '100', distribution: 'linear' },
  solar: { budget: '', distribution: 'local' },
};

const has = (driverId) => !!UNITS[driverId];
const months = (homey) => homey.__('budget.months').split(',').map((m) => m.trim());
const unit = (driverId) => UNITS[driverId] || '';
const pairPreset = (driverId) => PAIR_PRESETS[driverId] || null;

const distributions = (driverId) => ['linear', ...(Budget.localKind(driverId) ? ['local'] : []), 'CUSTOM'];
const heatingKind = (driverId) => {
  const local = Budget.localKind(driverId);
  return local && HEATING[local.kind] ? local.kind : null;
};
const heatingKey = (kind, id) => `budget.heating_${kind === 'gas' ? 'gas_' : ''}${id}`;
const distKey = (id) => `budget.${id === 'CUSTOM' ? 'custom' : id}`;

/**
 * The setting definitions by id, labels in the language of Homey ({} without a budget).
 * @param {object} homey
 * @param {string} driverId
 */
const defs = (homey, driverId) => {
  if (!has(driverId)) return {};
  const kind = heatingKind(driverId);
  const out = {
    // A day (1-28: every month has it, the month starts on it too) and a month in the view.
    start_date: {
      type: 'daymonth', value: DEFAULTS.start_date, label: homey.__('budget.start_date'), info: homey.__('budget.start_date_info'), months: months(homey),
    },
    budget: {
      type: 'text',
      value: DEFAULTS.budget,
      label: `${homey.__('budget.target')} (${UNITS[driverId]})`,
      info: driverId === 'solar' ? homey.__('budget.target_info_solar') : undefined,
    },
    distribution: {
      type: 'dropdown',
      value: DEFAULTS.distribution,
      label: homey.__('budget.distribution'),
      values: distributions(driverId).map((id) => ({ id, label: homey.__(distKey(id)) })),
    },
  };
  if (kind) {
    out.budget_heating = {
      type: 'dropdown',
      value: DEFAULTS.budget_heating[kind],
      label: homey.__('budget.heating'),
      values: HEATING[kind].map((id) => ({ id, label: homey.__(heatingKey(kind, id)) })),
    };
  }
  if (kind === 'electricity') out.budget_cooling = { type: 'checkbox', value: DEFAULTS.budget_cooling, label: homey.__('budget.cooling') };
  Object.entries(out).forEach(([id, def]) => {
    def.id = id;
  });
  return out;
};

/**
 * Settings to write at migration, or null. 'NONE' became budget 0; a fixed regional profile
 * became 'local' where the driver has it, another one no longer offered 'linear'.
 */
const migrate = (settings, driverId) => {
  if (!has(driverId)) return null;
  const offered = distributions(driverId);
  const d = settings.distribution;
  if (!d || d === 'NONE') return { budget: '0', distribution: DEFAULTS.distribution };
  if (!offered.includes(d)) return { distribution: REGIONAL.includes(d) && offered.includes('local') ? 'local' : DEFAULTS.distribution };
  return null;
};

/**
 * A start date ddmm, or null when invalid.
 */
const validStartDate = (value) => {
  const s = String(value || '').trim();
  if (!/^\d{4}$/.test(s)) return null;
  const day = Number(s.slice(0, 2));
  const month = Number(s.slice(2, 4));
  return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? s : null;
};

/**
 * Settings-page summary: '4500 kWh · Local climate (auto) · Heat pump · start 0101'.
 */
const summary = (homey, settings, driverId) => {
  if (!has(driverId)) return '';
  const date = validStartDate(settings.start_date) || DEFAULTS.start_date;
  const start = `${homey.__('budget.start')} ${Number(date.slice(0, 2))} ${months(homey)[Number(date.slice(2, 4)) - 1]}`;
  if (!Budget.isActive(settings.distribution, settings.budget)) return `${homey.__('budget.off')} · ${start}`;
  const total = settings.distribution === 'CUSTOM'
    ? String(settings.budget).split(';').reduce((a, v) => a + Number(v), 0) : Number(settings.budget);
  const parts = [`${Math.round(total)} ${UNITS[driverId]}`, homey.__(distKey(settings.distribution)).replace(/\s*\(.*\)$/, '')];
  const kind = heatingKind(driverId);
  if (settings.distribution === 'local' && kind) {
    parts.push(homey.__(heatingKey(kind, settings.budget_heating || DEFAULTS.budget_heating[kind])));
    if (kind === 'electricity' && settings.budget_cooling) parts.push(homey.__('budget.cooling'));
  }
  return `${parts.join(' · ')} · ${start}`;
};

/**
 * 12 monthly values from the custom view as the CUSTOM budget ('v1;...;v12'), or null.
 */
const customBudget = (values) => {
  if (!Array.isArray(values) || values.length !== 12) return null;
  const nums = values.map((v) => Number(String(v).replace(',', '.')));
  if (!nums.every((v) => Number.isFinite(v) && v >= 0) || !nums.some((v) => v > 0)) return null;
  return nums.map((v) => Math.round(v * 100) / 100).join(';');
};

// The location for the climate data: the device's own (solar), else Homey's.
const location = (homey, settings) => {
  const own = [Number(settings.lat), Number(settings.lon)];
  return own.every((v) => Number.isFinite(v) && v !== 0) ? own : [homey.geolocation.getLatitude(), homey.geolocation.getLongitude()];
};

/**
 * Shares to spread a year total over the months in the custom view: even (by days) and, where the
 * driver has it, like the local climate with these settings (null when the data is not there).
 */
const spreadShares = async (homey, driverId, settings) => {
  const out = { even: DAYS.map((d) => d / 365), local: null };
  const local = Budget.localKind(driverId);
  if (!local) return out;
  const [lat, lon] = location(homey, settings);
  if (local.kind === 'pv') {
    out.local = ClimateProfile.pvProfile(await ClimateNormals.get(homey, 'pv', lat, lon));
  } else {
    out.local = ClimateProfile.profile({
      kind: local.kind,
      climate: await ClimateNormals.get(homey, 'temp', lat, lon),
      lat,
      heating: settings.budget_heating || (local.kind === 'gas' ? 'boiler' : 'none'),
      cooling: !!settings.budget_cooling,
    });
  }
  return out;
};

/**
 * Solar year budget (kWh) from the peak power (W) and the PV yield at the location, or null.
 */
const solarEstimate = async (homey, settings) => {
  const kwp = Number(settings.peakPower) / 1000;
  if (!(kwp > 0)) return null;
  const [lat, lon] = location(homey, settings);
  const monthly = await ClimateNormals.get(homey, 'pv', lat, lon);
  if (!Array.isArray(monthly)) return null;
  return Math.round(kwp * monthly.reduce((a, v) => a + v, 0));
};

module.exports = {
  has,
  unit,
  months,
  pairPreset,
  customBudget,
  spreadShares,
  solarEstimate,
  defs,
  migrate,
  summary,
  validStartDate,
};
