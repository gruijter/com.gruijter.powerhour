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

const MAX_COUNT = 15;

const PRESETS = {
  flanders: {
    peakLoadIntervalMinutes: '15',
    peakSelection: 'max',
    peakCount: 1,
    peakDistinctDays: false,
    peakHours: '',
    peakWeekdaysOnly: false,
    peakMonths: '',
    peakWeightOutside: 0,
    peakMinimumW: 2500,
    peakSteps: '',
  },
  norway: {
    peakLoadIntervalMinutes: '60',
    peakSelection: 'mean',
    peakCount: 3,
    peakDistinctDays: true,
    peakHours: '',
    peakWeekdaysOnly: false,
    peakMonths: '',
    peakWeightOutside: 0,
    peakMinimumW: 0,
    peakPrice: 0,
  },
  sweden: {
    peakLoadIntervalMinutes: '60',
    peakSelection: 'mean',
    peakCount: 3,
    peakDistinctDays: true,
    peakHours: '',
    peakWeekdaysOnly: false,
    peakMonths: '',
    peakWeightOutside: 0,
    peakMinimumW: 0,
    peakSteps: '',
  },
};

const TARIFF_KEYS = ['peakLoadIntervalMinutes', 'peakSelection', 'peakCount', 'peakDistinctDays',
  'peakHours', 'peakWeekdaysOnly', 'peakMonths', 'peakWeightOutside', 'peakMinimumW', 'peakPrice', 'peakSteps'];

const leavesPreset = (preset, changedKeys) => !!PRESETS[preset]
  && changedKeys.some((key) => TARIFF_KEYS.includes(key) && Object.prototype.hasOwnProperty.call(PRESETS[preset], key));

const toNumber = (v) => Number(typeof v === 'string' ? v.trim().replace(',', '.') : v);

const parseHours = (text) => {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > 23 || to > 24 || from === to % 24) return undefined;
  return { from, to: to % 24 };
};

const parseMonths = (text) => {
  const s = String(text || '').trim();
  if (!s) return null;
  const months = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) return undefined;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || from > 12 || to < 1 || to > 12) return undefined;
    for (let k = from; ; k = (k % 12) + 1) {
      months.add(k);
      if (k === to) break;
    }
  }
  return months;
};

const parseSteps = (text) => {
  const s = String(text || '').trim();
  if (!s) return [];
  const steps = [];
  for (const part of s.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([\d.,]+)\s*(?:kw)?\s*[:=]\s*([\d.,]+)$/i);
    if (!m) return undefined;
    const toW = toNumber(m[1]) * 1000;
    const price = toNumber(m[2]);
    if (!(toW > 0) || !Number.isFinite(price)) return undefined;
    steps.push({ toW, price });
  }
  steps.sort((a, b) => a.toW - b.toW);
  return steps;
};

const invalidReason = (settings) => {
  if (parseHours(settings.peakHours) === undefined) return 'error_peak_hours';
  if (parseMonths(settings.peakMonths) === undefined) return 'error_peak_months';
  if (parseSteps(settings.peakSteps) === undefined) return 'error_peak_steps';
  return null;
};

const configFromSettings = (settings) => {
  const n = Number(settings.peakLoadIntervalMinutes);
  const selection = ['max', 'mean', 'nth'].includes(settings.peakSelection) ? settings.peakSelection : 'max';
  const count = selection === 'max' ? 1 : Math.max(1, Math.min(MAX_COUNT, Math.round(Number(settings.peakCount) || 1)));
  const weightOutside = Number(settings.peakWeightOutside);
  return {
    preset: PRESETS[settings.peakPreset] ? settings.peakPreset : 'custom',
    windowMin: [15, 30, 60].includes(n) ? n : 15,
    selection,
    count,
    distinctDays: !!settings.peakDistinctDays,
    hours: parseHours(settings.peakHours) || null,
    weekdaysOnly: !!settings.peakWeekdaysOnly,
    months: parseMonths(settings.peakMonths) || null,
    weightOutside: Number.isFinite(weightOutside) ? Math.max(0, Math.min(1, weightOutside)) : 0,
    minimumW: Math.max(0, Number(settings.peakMinimumW) || 0),
    pricePerKw: Math.max(0, toNumber(settings.peakPrice) || 0),
    steps: parseSteps(settings.peakSteps) || [],
    hardLimitW: Math.max(0, Number(settings.peakHardLimitW) || 0),
  };
};

const isActive = (config) => config.pricePerKw > 0 || config.steps.length > 0 || config.preset !== 'custom';

const hasWeighting = (config) => !!(config.hours || config.weekdaysOnly || config.months);

const weightAt = (config, localDate) => {
  if (!hasWeighting(config)) return 1;
  const hour = localDate.getHours();
  const { hours } = config;
  const inHours = !hours || (hours.from < hours.to
    ? hour >= hours.from && hour < hours.to
    : hour >= hours.from || hour < hours.to);
  const weekday = localDate.getDay();
  const inDays = !config.weekdaysOnly || (weekday >= 1 && weekday <= 5);
  const inMonths = !config.months || config.months.has(localDate.getMonth() + 1);
  return inHours && inDays && inMonths ? 1 : config.weightOutside;
};

const pad = (v) => String(v).padStart(2, '0');
const monthKeyOf = (localDate) => `${localDate.getFullYear()}-${pad(localDate.getMonth() + 1)}`;
const dayKeyOf = (localDate) => `${monthKeyOf(localDate)}-${pad(localDate.getDate())}`;

const signature = (config) => [config.windowMin, config.hours ? `${config.hours.from}-${config.hours.to}` : '',
  config.weekdaysOnly ? 1 : 0, config.months ? [...config.months].sort((a, b) => a - b).join(',') : '',
  hasWeighting(config) ? config.weightOutside : 0].join('|');

const emptyHistory = (config, monthKey) => ({
  sig: signature(config), month: monthKey, days: {}, top: [],
});

const recordWindow = (history, config, { monthKey, dayKey, weightedW }) => {
  const h = history && history.month === monthKey && history.sig === signature(config)
    ? { ...history, days: { ...history.days }, top: [...history.top] }
    : emptyHistory(config, monthKey);
  const v = Math.max(0, Math.round(weightedW));
  if (!(h.days[dayKey] >= v)) h.days[dayKey] = v;
  h.top.push(v);
  h.top.sort((a, b) => b - a);
  if (h.top.length > MAX_COUNT) h.top.length = MAX_COUNT;
  return h;
};

const currentHistory = (history, config, monthKey) => (history && history.month === monthKey && history.sig === signature(config)
  ? history : emptyHistory(config, monthKey));

const valuesOf = (h, config) => (config.distinctDays ? Object.values(h.days) : h.top);

const stepFor = (config, w) => {
  const { steps } = config;
  if (!steps.length) return null;
  const idx = steps.findIndex((s) => w <= s.toW);
  if (idx === -1) return { upperW: Infinity, price: steps[steps.length - 1].price, next: null };
  return { upperW: steps[idx].toW, price: steps[idx].price, next: steps[idx + 1] || null };
};

const billedW = (history, config, monthKey) => {
  const h = currentHistory(history, config, monthKey);
  const vals = [...valuesOf(h, config)].sort((a, b) => b - a);
  if (!vals.length) return config.minimumW > 0 ? config.minimumW : null;
  const top = vals.slice(0, config.count);
  let b;
  if (config.selection === 'mean') b = top.reduce((a, v) => a + v, 0) / top.length;
  else if (config.selection === 'nth') b = vals.length >= config.count ? top[top.length - 1] : 0;
  else b = vals[0];
  return Math.round(Math.max(b, config.minimumW));
};

const threshold = (history, config, { monthKey, dayKey, fillW = 0 }) => {
  const h = currentHistory(history, config, monthKey);
  const N = config.count;
  const today = config.distinctDays ? h.days[dayKey] : undefined;
  const others = config.distinctDays
    ? Object.entries(h.days).filter(([k]) => k !== dayKey).map(([, v]) => v)
    : [...h.top];
  const present = others.length + (today !== undefined ? 1 : 0);
  const fill = config.selection === 'max' ? 0 : Math.max(0, fillW);
  const pool = [...others, ...(today !== undefined ? [today] : [])];
  for (let i = present; i < N; i += 1) pool.push(fill);
  pool.sort((a, b) => b - a);
  const top = pool.slice(0, N);
  const sum = top.reduce((a, v) => a + v, 0);
  const replaced = today !== undefined && today >= top[N - 1] ? today : top[N - 1];

  let billed;
  if (config.selection === 'mean') billed = sum / N;
  else if (config.selection === 'nth') billed = top[N - 1];
  else billed = top[0];
  billed = Math.max(billed, config.minimumW);

  const step = stepFor(config, billed);
  const level = Math.max(config.minimumW, step ? step.upperW : 0);
  const nthFree = config.selection === 'nth' && N > 1 && (top[N - 2] <= level || (today !== undefined && today > top[N - 1]));
  let xLevel;
  if (level === Infinity || nthFree) xLevel = Infinity;
  else if (config.selection === 'mean') xLevel = (N * level) - sum + replaced;
  else xLevel = level;
  const thresholdW = present === 0 && fill === 0 && level === 0 ? null : Math.max(replaced, xLevel);

  let penaltyPerKw = null;
  if (config.pricePerKw > 0) penaltyPerKw = config.selection === 'mean' ? config.pricePerKw / N : config.pricePerKw;
  const stepJump = step && step.next ? step.next.price - step.price : null;
  return {
    thresholdW: thresholdW === null || thresholdW === Infinity ? thresholdW : Math.round(thresholdW),
    billedW: Math.round(billed),
    penaltyPerKw,
    stepJump,
  };
};

module.exports = {
  PRESETS,
  TARIFF_KEYS,
  leavesPreset,
  MAX_COUNT,
  parseHours,
  parseMonths,
  parseSteps,
  invalidReason,
  configFromSettings,
  isActive,
  hasWeighting,
  weightAt,
  monthKeyOf,
  dayKeyOf,
  signature,
  recordWindow,
  billedW,
  threshold,
};
