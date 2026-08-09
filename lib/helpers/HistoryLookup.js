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
 * Find the closest sample to timeMs in a { time, [valueKey]: number } time-series array,
 * within windowMs. Dependency-free (no `this`) so it can be called both as the implementation
 * behind ChargeDeviceHelpers' device-instance methods (getActualPowerForTime/getActualSocForTime)
 * and directly from the solar/grid chart renderers, which are plain functions with no device
 * instance to mix helpers into.
 *
 * @param {Array<{time: number}>} history - time-series array, entries shaped { time, [valueKey]: number }
 * @param {number} timeMs - Unix timestamp in milliseconds to look up
 * @param {number} windowMs - maximum allowed distance from timeMs, in milliseconds
 * @param {string} valueKey - property name holding the numeric value (e.g. 'power', 'soc')
 * @returns {number|null} the closest value within the window, or null if none found
 */
const findClosestSample = (history, timeMs, windowMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  const candidates = history.filter((d) => Math.abs(d.time - timeMs) < windowMs);
  if (candidates.length === 0) return null;
  const closest = candidates.sort((a, b) => Math.abs(a.time - timeMs) - Math.abs(b.time - timeMs))[0];
  return typeof closest[valueKey] === 'number' ? closest[valueKey] : null;
};

// Homey Insights' named 'yesterday' resolution (5-minute buckets) always returns the fixed
// previous calendar day - it ignores any start/end passed alongside it and never includes
// today's in-progress data (confirmed empirically: a request with end=now still came back
// with its last sample from ~22:00 the previous day). 'today' is the matching same-resolution
// counterpart for the current calendar day so far - combining them gives real "yesterday
// through now" coverage, so a restart backfills today's gap instead of leaving it to rebuild
// from scratch via live pushes alone. Was duplicated near-identically in grid/device.js and
// solar/device.js; unified here so the two can't silently drift apart again.
const fetchYesterdayAndToday = async (api, logId) => {
  const fetchRes = async (resolution) => api.insights.getLogEntries({ id: logId, resolution }).catch(() => null);
  const [yesterday, today] = await Promise.all([fetchRes('yesterday'), fetchRes('today')]);
  const values = [
    ...(yesterday && yesterday.values ? yesterday.values : []),
    ...(today && today.values ? today.values : []),
  ];
  return { values };
};

// Convert a cumulative energy (kWh) Insights log into average-power (W) samples between each
// pair of consecutive readings. Was duplicated in grid/device.js and solar/device.js with one
// real behavioral difference: grid emitted multiple 5-minute-stepped samples across each gap
// (to avoid leaving 15-minute chart slots null/sawtooth-shaped between infrequent cumulative
// readings), while solar emitted a single sample at the gap's midpoint. The two are equivalent
// for short gaps (a 1-step gap's only sample IS the midpoint), so grid's version - which only
// differs for longer gaps, where it's strictly better - is kept as the single implementation.
const convertCumulativeToPower = (entries) => {
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
      const dE = currVal - prevVal; // Energy diff (kWh)
      if (dE >= -0.0001) { // ignore resets, but allow small float noise
        const safeDE = Math.max(0, dE);
        const power = (safeDE / dt) * 1000; // kWh -> W
        if (power >= 0 && power <= 30000) {
          // Emit continuous samples every 5 minutes across the cumulative gap to prevent
          // 15-minute chart slots from being left empty and dropping to 0W.
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

module.exports = { findClosestSample, fetchYesterdayAndToday, convertCumulativeToPower };
