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

const { meterToPower } = require('./InsightsHistory');

/**
 * Closest sample to timeMs within windowMs. No `this`: also used by the chart renderers.
 *
 * @param {Array<{time: number}>} history - entries shaped { time, [valueKey]: number }
 * @param {number} timeMs
 * @param {number} windowMs - maximum distance from timeMs
 * @param {string} valueKey - e.g. 'power', 'soc'
 * @returns {number|null}
 */
const findClosestSample = (history, timeMs, windowMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  // Single pass: this runs once per chart slot over histories of up to 2880 entries.
  let closest = null;
  let bestDist = windowMs;
  for (let i = 0; i < history.length; i += 1) {
    const dist = Math.abs(history[i].time - timeMs);
    if (dist < bestDist) {
      bestDist = dist;
      closest = history[i];
    }
  }
  if (!closest) return null;
  return typeof closest[valueKey] === 'number' ? closest[valueKey] : null;
};

// Insights resolution 'yesterday' (5-minute) always returns the previous calendar day and
// ignores start/end (confirmed live); 'today' adds the current day so far.
const fetchYesterdayAndToday = async (api, logId) => {
  const fetchRes = async (resolution) => api.insights.getLogEntries({ id: logId, resolution }).catch(() => null);
  const [yesterday, today] = await Promise.all([fetchRes('yesterday'), fetchRes('today')]);
  const values = [
    ...(yesterday && yesterday.values ? yesterday.values : []),
    ...(today && today.values ? today.values : []),
  ];
  return { values };
};

// Cumulative energy (kWh) Insights log to power (W) {t, y} (InsightsHistory.meterToPower()), each
// entry's power repeated every 5 minutes until the next entry (within a day), so 15-minute chart
// slots are not left empty. maxPowerW: plausibility ceiling (grid passes its connection-derived one).
const STEP_MS = 5 * 60 * 1000;
const convertCumulativeToPower = (entries, maxPowerW = 30000) => {
  const power = meterToPower(entries, { maxW: maxPowerW, minGapMs: 36 * 1000, maxGapMs: 24 * 3600 * 1000 });
  const out = [];
  power.forEach((p, i) => {
    const next = power[i + 1];
    const steps = next && next.t - p.t < 24 * 3600 * 1000 ? Math.max(1, Math.floor((next.t - p.t) / STEP_MS)) : 1;
    for (let k = 0; k < steps; k += 1) out.push({ t: p.t + k * STEP_MS, y: p.v });
  });
  return out;
};

// Light 3-tap moving average per device series before combining meters: their reporting times
// differ, so one event can land an hour apart in two logs and leave a spike in the combination
// (confirmed 2026-08-10 on two Homeys reading the same hardware).
const smoothTimeSeries = (entries) => {
  if (!Array.isArray(entries) || entries.length < 3) return entries;
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  return sorted.map((e, i) => {
    if (i === 0 || i === sorted.length - 1) return e;
    const prevVal = sorted[i - 1].y !== undefined ? sorted[i - 1].y : sorted[i - 1].v;
    const currVal = e.y !== undefined ? e.y : e.v;
    const nextVal = sorted[i + 1].y !== undefined ? sorted[i + 1].y : sorted[i + 1].v;
    if (typeof prevVal !== 'number' || typeof currVal !== 'number' || typeof nextVal !== 'number') return e;
    const smoothedVal = (prevVal * 0.25) + (currVal * 0.5) + (nextVal * 0.25);
    return { ...e, [e.y !== undefined ? 'y' : 'v']: smoothedVal };
  });
};

/**
 * Mean of all samples with startMs <= time < endMs, or null. A point at the slot boundary would
 * shift a transition by a whole slot.
 *
 * @param {Array<{time: number}>} history - entries shaped { time, [valueKey]: number }
 * @param {number} startMs - inclusive
 * @param {number} endMs - exclusive
 * @param {string} valueKey
 * @returns {number|null}
 */
const averageSamplesInWindow = (history, startMs, endMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  let sum = 0;
  let count = 0;
  history.forEach((d) => {
    if (d && d.time >= startMs && d.time < endMs && typeof d[valueKey] === 'number') {
      sum += d[valueKey];
      count += 1;
    }
  });
  return count > 0 ? sum / count : null;
};

/**
 * Stored history merged with the newer samples in memory (restartDevice() keeps the instance).
 * Load before super.onInit(), or a fresh instance's first save overwrites the store.
 *
 * @param {Array<{time: number}>} stored - oldest first
 * @param {Array<{time: number}>|undefined} current - oldest first
 * @param {number} max - entries to keep
 * @returns {Array}
 */
const mergeStoredHistory = (stored, current, max) => {
  const base = Array.isArray(stored) ? stored : [];
  if (!Array.isArray(current) || current.length === 0) return base.slice(-max);
  const firstTm = current[0].time;
  return base.filter((e) => e.time < firstTm).concat(current).slice(-max);
};

module.exports = {
  findClosestSample,
  averageSamplesInWindow,
  fetchYesterdayAndToday,
  convertCumulativeToPower,
  smoothTimeSeries,
  mergeStoredHistory,
};
