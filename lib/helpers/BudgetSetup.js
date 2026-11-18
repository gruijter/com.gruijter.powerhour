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
const PAIR_PRESETS = {
  grid: { budget: '2500', distribution: 'local' },
  gas: { budget: '1100', distribution: 'local' },
  water: { budget: '100', distribution: 'linear' },
  solar: { budget: '', distribution: 'local' },
};

const has = (driverId) => !!UNITS[driverId];
const hasContract = (driverId) => ['grid', 'gas', 'water'].includes(driverId);
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

const defs = (homey, driverId) => {
  if (!has(driverId)) return {};
  const kind = heatingKind(driverId);
  const out = {
    start_date: hasContract(driverId) ? {
      type: 'daymonth', value: DEFAULTS.start_date, label: homey.__('budget.start_date'), info: homey.__('budget.start_date_info'), months: months(homey),
    } : undefined,
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
  if (!out.start_date) delete out.start_date;
  Object.entries(out).forEach(([id, def]) => {
    def.id = id;
  });
  return out;
};

const migrate = (settings, driverId) => {
  if (!has(driverId)) return null;
  const offered = distributions(driverId);
  const d = settings.distribution;
  if (!d || d === 'NONE') return { budget: '0', distribution: DEFAULTS.distribution };
  if (offered.includes(d)) return null;
  const local = Budget.localKind(driverId);
  if (local && local.fallback === d) return { distribution: 'local' };
  const shares = REGIONAL.includes(d) ? Budget.fixedShares(d) : null;
  if (shares && Budget.isActive(d, settings.budget)) {
    const total = Number(settings.budget);
    return { distribution: 'CUSTOM', budget: shares.map((s) => Math.round(s * total * 100) / 100).join(';') };
  }
  return { distribution: DEFAULTS.distribution };
};

const dateText = (homey, ddmm) => `${Number(ddmm.slice(0, 2))} ${months(homey)[Number(ddmm.slice(2, 4)) - 1]}`;

const validStartDate = (value) => {
  const s = String(value || '').trim();
  if (!/^\d{4}$/.test(s)) return null;
  const day = Number(s.slice(0, 2));
  const month = Number(s.slice(2, 4));
  return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? s : null;
};

const summary = (homey, settings, driverId) => {
  if (!has(driverId)) return '';
  if (!Budget.isActive(settings.distribution, settings.budget)) return homey.__('budget.off');
  const total = settings.distribution === 'CUSTOM'
    ? String(settings.budget).split(';').reduce((a, v) => a + Number(v), 0) : Number(settings.budget);
  const parts = [`${Math.round(total)} ${UNITS[driverId]}`, homey.__(distKey(settings.distribution)).replace(/\s*\(.*\)$/, '')];
  const kind = heatingKind(driverId);
  if (settings.distribution === 'local' && kind) {
    parts.push(homey.__(heatingKey(kind, settings.budget_heating || DEFAULTS.budget_heating[kind])));
    if (kind === 'electricity' && settings.budget_cooling) parts.push(homey.__('budget.cooling'));
  }
  return parts.join(' · ');
};

const customBudget = (values) => {
  if (!Array.isArray(values) || values.length !== 12) return null;
  const nums = values.map((v) => Number(String(v).replace(',', '.')));
  if (!nums.every((v) => Number.isFinite(v) && v >= 0) || !nums.some((v) => v > 0)) return null;
  return nums.map((v) => Math.round(v * 100) / 100).join(';');
};

const location = (homey, settings) => {
  const own = [Number(settings.lat), Number(settings.lon)];
  return own.every((v) => Number.isFinite(v) && v !== 0) ? own : [homey.geolocation.getLatitude(), homey.geolocation.getLongitude()];
};

const localProfile = async (homey, driverId, settings, maxWaitMs = 0) => {
  const local = Budget.localKind(driverId);
  if (!local) return null;
  const [lat, lon] = location(homey, settings);
  if (local.kind === 'pv') return ClimateProfile.pvProfile(await ClimateNormals.get(homey, 'pv', lat, lon, maxWaitMs));
  return ClimateProfile.profile({
    kind: local.kind,
    climate: await ClimateNormals.get(homey, 'temp', lat, lon, maxWaitMs),
    lat,
    heating: settings.budget_heating || DEFAULTS.budget_heating[local.kind],
    cooling: !!settings.budget_cooling,
  });
};

const spreadShares = async (homey, driverId, settings, maxWaitMs = 0) => ({
  even: DAYS.map((d) => d / 365),
  local: await localProfile(homey, driverId, settings, maxWaitMs),
});

const solarEstimate = async (homey, settings, maxWaitMs = 0) => {
  const kwp = Number(settings.peakPower) / 1000;
  if (!(kwp > 0)) return null;
  const [lat, lon] = location(homey, settings);
  const monthly = await ClimateNormals.get(homey, 'pv', lat, lon, maxWaitMs);
  if (!Array.isArray(monthly)) return null;
  return Math.round(kwp * monthly.reduce((a, v) => a + v, 0));
};

module.exports = {
  has,
  hasContract,
  unit,
  months,
  pairPreset,
  customBudget,
  spreadShares,
  localProfile,
  solarEstimate,
  defs,
  migrate,
  summary,
  validStartDate,
  dateText,
};
