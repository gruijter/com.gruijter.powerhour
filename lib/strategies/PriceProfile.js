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

const TimeHelpers = require('../helpers/TimeHelpers');
const EvUsageModel = require('./EvUsageModel');

const ALPHA = 0.25;
const LEVEL_FADE_DAYS = 3;
const DAILY_MIN_DAYS = 14;
const DAILY_MIN_MIN_DAYS = 5;
const DAILY_MIN_MIN_HOURS = 20;
const DAILY_LOW_HOURS = 8;

const grid = () => Array.from({ length: 7 }, () => new Array(24).fill(null));

const createProfile = () => ({
  import: grid(),
  export: grid(),
  lastLearnedMs: 0,
  dailyMin: {},
  dailyLows: {},
  dailySums: {},
});

const localDate = (ms, timezone) => EvUsageModel.localDateStr(new Date(ms), timezone);

const addDailyMins = (profile, hourly, timezone) => {
  const mins = { ...(profile.dailyMin || {}) };
  hourly.forEach(({ time, price }) => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    const date = localDate(time, timezone);
    if (!(date in mins) || price < mins[date]) mins[date] = price;
  });
  const keep = Object.keys(mins).sort().slice(-DAILY_MIN_DAYS);
  profile.dailyMin = Object.fromEntries(keep.map((d) => [d, mins[d]]));
  const byDate = {};
  hourly.forEach(({ time, price }) => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    const date = localDate(time, timezone);
    (byDate[date] = byDate[date] || []).push(price);
  });
  const lows = { ...(profile.dailyLows || {}) };
  Object.entries(byDate).forEach(([date, prices]) => {
    lows[date] = prices.sort((a, b) => a - b).slice(0, DAILY_LOW_HOURS);
  });
  const keepLows = Object.keys(lows).sort().slice(-DAILY_MIN_DAYS);
  profile.dailyLows = Object.fromEntries(keepLows.map((d) => [d, lows[d]]));
  return profile;
};

const bucket = (ms, timezone) => {
  const local = TimeHelpers.toLocalDate(new Date(ms), timezone);
  return { dow: (local.getDay() + 6) % 7, hour: local.getHours() };
};

const ewa = (cur, v) => (cur === null ? v : cur * (1 - ALPHA) + v * ALPHA);

const learn = (profile, entries, timezone) => {
  const byHour = (list) => {
    const hours = new Map();
    list.forEach((e) => {
      const hourMs = TimeHelpers.startOfLocalBlock(e.time, 60, timezone);
      const h = hours.get(hourMs) || { imp: [], exp: [], last: 0 };
      h.imp.push(e.price);
      if (typeof e.exportPrice === 'number') h.exp.push(e.exportPrice);
      h.last = Math.max(h.last, e.time);
      hours.set(hourMs, h);
    });
    return hours;
  };
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const valid = (entries || []).filter((e) => typeof e.price === 'number');
  const hourly = [...byHour(valid).entries()].map(([hourMs, h]) => ({ time: hourMs, price: avg(h.imp) }));
  const hoursPerDay = {};
  hourly.forEach((h) => {
    const date = localDate(h.time, timezone);
    hoursPerDay[date] = (hoursPerDay[date] || 0) + 1;
  });
  addDailyMins(profile, hourly.filter((h) => hoursPerDay[localDate(h.time, timezone)] >= DAILY_MIN_MIN_HOURS), timezone);
  const hours = byHour(valid.filter((e) => e.time > profile.lastLearnedMs));
  [...hours.entries()].sort((a, b) => a[0] - b[0]).forEach(([hourMs, h]) => {
    const { dow, hour } = bucket(hourMs, timezone);
    profile.import[dow][hour] = ewa(profile.import[dow][hour], avg(h.imp));
    if (h.exp.length) profile.export[dow][hour] = ewa(profile.export[dow][hour], avg(h.exp));
    profile.lastLearnedMs = Math.max(profile.lastLearnedMs, h.last);
  });
  return profile;
};

const rawExpected = (profile, ms, timezone) => {
  const { dow, hour } = bucket(ms, timezone);
  return { price: profile.import[dow][hour], exportPrice: profile.export[dow][hour] };
};

const level = (profile, known, timezone, nowMs) => {
  const sum = { known: 0, profile: 0, n: 0 };
  const sumExp = { known: 0, profile: 0, n: 0 };
  (known || []).forEach((e) => {
    const exp = rawExpected(profile, e.time, timezone);
    if (typeof exp.price === 'number' && typeof e.price === 'number') {
      sum.known += e.price;
      sum.profile += exp.price;
      sum.n += 1;
    }
    if (typeof exp.exportPrice === 'number' && typeof e.exportPrice === 'number') {
      sumExp.known += e.exportPrice;
      sumExp.profile += exp.exportPrice;
      sumExp.n += 1;
    }
  });
  const shift = (x) => (x.n ? (x.known - x.profile) / x.n : 0);
  return { import: shift(sum), export: shift(sumExp), nowMs };
};

const expected = (profile, ms, timezone, lvl = null) => {
  const raw = rawExpected(profile, ms, timezone);
  const w = lvl ? Math.min(1, Math.max(0, 1 - (ms - lvl.nowMs) / (LEVEL_FADE_DAYS * 24 * 3600 * 1000))) : 0;
  return {
    price: typeof raw.price === 'number' ? raw.price + (w ? w * lvl.import : 0) : null,
    exportPrice: typeof raw.exportPrice === 'number' ? raw.exportPrice + (w ? w * lvl.export : 0) : null,
  };
};

const typicalDailyMin = (profile) => {
  const v = Object.values((profile && profile.dailyMin) || {}).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < DAILY_MIN_MIN_DAYS) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

const typicalDayCost = (profile, hours) => {
  const k = Math.max(1, Math.min(DAILY_LOW_HOURS, Math.round(hours)));
  const v = Object.values((profile && profile.dailyLows) || {}).filter((l) => Array.isArray(l) && l.length >= k)
    .map((l) => l.slice(0, k).reduce((a, b) => a + b, 0) / k).sort((a, b) => a - b);
  if (v.length < DAILY_MIN_MIN_DAYS) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

const dailyMinDays = (profile) => Object.keys((profile && profile.dailyMin) || {}).length;

const AVERAGE_DAYS = 28;

const addDailySums = (profile, hourly, timezone, nowMs = Date.now()) => {
  const fresh = {};
  hourly.forEach(({ time, price }) => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    const date = localDate(time, timezone);
    const d = fresh[date] || (fresh[date] = [0, 0]);
    d[0] += price;
    d[1] += 1;
  });
  const today = localDate(nowMs, timezone);
  const sums = {};
  Object.entries(profile.dailySums || {}).forEach(([date, d]) => {
    if (date <= today) sums[date] = d;
  });
  Object.entries(fresh).forEach(([date, d]) => {
    if (date > today || !sums[date] || d[1] >= sums[date][1]) sums[date] = d;
  });
  const keep = Object.keys(sums).filter((date) => date <= today).sort().slice(-AVERAGE_DAYS)
    .concat(Object.keys(sums).filter((date) => date > today));
  profile.dailySums = Object.fromEntries(keep.map((date) => [date, sums[date]]));
};

const average = (profile) => {
  const days = Object.values((profile && profile.dailySums) || {});
  const hours = days.reduce((a, d) => a + d[1], 0);
  return hours ? days.reduce((a, d) => a + d[0], 0) / hours : null;
};

const isEmpty = (profile) => !profile || profile.import.every((day) => day.every((v) => v === null));

module.exports = {
  addDailyMins,
  addDailySums,
  average,
  typicalDailyMin,
  typicalDayCost,
  dailyMinDays,
  createProfile,
  learn,
  level,
  expected,
  isEmpty,
};
