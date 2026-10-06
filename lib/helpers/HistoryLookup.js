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

// Cumulative energy (kWh) Insights log to average power (W), stepped every 5 minutes across each
// gap. maxPowerW: plausibility ceiling (grid passes its connection-derived one).
const convertCumulativeToPower = (entries, maxPowerW = 30000) => {
  const powerEntries = [];
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const curr = entries[i];
    const prevVal = prev.y !== undefined ? prev.y : prev.v;
    const currVal = curr.y !== undefined ? curr.y : curr.v;

    if (typeof prevVal !== 'number' || typeof currVal !== 'number') continue;

    const t1 = new Date(prev.t).getTime();
    const t2 = new Date(curr.t).getTime();
    const dt = (t2 - t1) / 3600000; // hours

    if (dt > 0.01 && dt < 24) { // ignore tiny or huge gaps
      const dE = currVal - prevVal; // kWh
      if (dE >= -0.0001) { // ignore resets, allow float noise
        const safeDE = Math.max(0, dE);
        const power = (safeDE / dt) * 1000; // kWh -> W
        if (power >= 0 && power <= maxPowerW) {
          // Every 5 minutes, so 15-minute chart slots are not left empty.
          const stepMs = 5 * 60 * 1000;
          const steps = Math.max(1, Math.floor((t2 - t1) / stepMs));
          for (let j = 1; j <= steps; j += 1) {
            const fraction = j / (steps + 1);
            const tStep = new Date(t1 + (t2 - t1) * fraction).getTime();
            powerEntries.push({ t: tStep, y: power });
          }
        }
      }
    }
  }
  return powerEntries;
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
