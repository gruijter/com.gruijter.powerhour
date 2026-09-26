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

// Expected import and export price per weekday and local hour, for planning beyond the published
// prices: on a Saturday the planner must know that weekday prices are usually higher. Learned as
// an exponentially weighted average of published market prices (forecasts excluded). Pure.

const TimeHelpers = require('../helpers/TimeHelpers');

const ALPHA = 0.25; // ~4 weeks memory per weekday-hour
const LEVEL_RANGE = [0.5, 2];
// Lowest (hourly) price per local day, for the days the cheap threshold looks back on.
const DAILY_MIN_DAYS = 14;
const DAILY_MIN_MIN_DAYS = 5; // fewer known days: no typical daily lowest price yet
const DAILY_MIN_MIN_HOURS = 20; // a day counts when (nearly) all its hours are known

const grid = () => Array.from({ length: 7 }, () => new Array(24).fill(null));

const createProfile = () => ({
  import: grid(),
  export: grid(),
  lastLearnedMs: 0,
  dailyMin: {}, // local date YYYY-MM-DD -> lowest hourly import price
});

const localDate = (ms, timezone) => {
  const d = TimeHelpers.toLocalDate(new Date(ms), timezone);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Take hourly prices into the lowest price per day, keeping the last DAILY_MIN_DAYS days.
const addDailyMins = (profile, hourly, timezone) => {
  const mins = { ...(profile.dailyMin || {}) };
  hourly.forEach(({ time, price }) => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    const date = localDate(time, timezone);
    if (!(date in mins) || price < mins[date]) mins[date] = price;
  });
  const keep = Object.keys(mins).sort().slice(-DAILY_MIN_DAYS);
  profile.dailyMin = Object.fromEntries(keep.map((d) => [d, mins[d]]));
  return profile;
};

const bucket = (ms, timezone) => {
  const local = TimeHelpers.toLocalDate(new Date(ms), timezone);
  return { dow: (local.getDay() + 6) % 7, hour: local.getHours() };
};

const ewa = (cur, v) => (cur === null ? v : cur * (1 - ALPHA) + v * ALPHA);

/**
 * Learn from price entries newer than the last learned one. Sub-hour prices are averaged per
 * local hour first, so a 15-minute source weighs the same as an hourly one.
 *
 * @param {object} profile
 * @param {Array<{time:number, price:number, exportPrice?:number}>} entries - slot start (ms)
 * @param {string} timezone
 */
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
  // Daily lowest prices from all given prices (a minimum can be taken again), so days already
  // learned into the profile still count; only (nearly) complete days: the rest of today alone
  // would give a too high lowest price.
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

/**
 * Price level now relative to the profile: the mean of the known prices over the profile's mean
 * for the same hours. Tracks seasons and fuel prices without waiting for the average to follow.
 */
const levelFactor = (profile, known, timezone) => {
  let sumKnown = 0;
  let sumProfile = 0;
  (known || []).forEach((e) => {
    const exp = rawExpected(profile, e.time, timezone).price;
    if (typeof exp === 'number' && typeof e.price === 'number') {
      sumKnown += e.price;
      sumProfile += exp;
    }
  });
  if (!(sumProfile > 0) || !(sumKnown > 0)) return 1;
  return Math.min(LEVEL_RANGE[1], Math.max(LEVEL_RANGE[0], sumKnown / sumProfile));
};

/**
 * Expected prices at ms, or nulls when this weekday-hour was never seen.
 */
const expected = (profile, ms, timezone, level = 1) => {
  const raw = rawExpected(profile, ms, timezone);
  return {
    price: typeof raw.price === 'number' ? raw.price * level : null,
    exportPrice: typeof raw.exportPrice === 'number' ? raw.exportPrice * level : null,
  };
};

// The usual lowest price of a day: the median of the daily lowest prices, or null while too few
// days are known.
const typicalDailyMin = (profile) => {
  const v = Object.values((profile && profile.dailyMin) || {}).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < DAILY_MIN_MIN_DAYS) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

const dailyMinDays = (profile) => Object.keys((profile && profile.dailyMin) || {}).length;

const isEmpty = (profile) => !profile || profile.import.every((day) => day.every((v) => v === null));

module.exports = {
  addDailyMins,
  typicalDailyMin,
  dailyMinDays,
  createProfile,
  learn,
  levelFactor,
  expected,
  isEmpty,
};
