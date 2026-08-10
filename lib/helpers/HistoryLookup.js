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

// Smooth a single device's own time series with a light 3-tap moving average (prev*0.25 +
// curr*0.5 + next*0.25 - same weights as the weekly-profile smoothing pass in
// LoadForecastStrategy.js) before it gets combined with OTHER independently-metered devices'
// series (e.g. grid + solar - battery - EV in reconstructHomePowerHistory()).
//
// Why this matters: grid, solar, battery and EV charger are separate physical meters/vendor
// integrations, each with their own independent polling/reporting timing - a short-duration
// event (a cloud-edge solar spike, a Sessy charge/discharge transition, an EV charging
// start/stop) can land in meter A's "hour N" Insights sample but meter B's "hour N-1" or
// "hour N+1" sample, purely due to that timing skew (confirmed can be 10+ seconds, sometimes
// enough to cross an hourly sample boundary). Combining perfectly-aligned-by-timestamp but
// NOT-actually-simultaneous samples then produces a spurious combined-signal spike or trough
// that isn't real home load, just a meter-timing artifact - confirmed in practice
// (2026-08-10): reconstructHomePowerHistory() produced substantially different weekly-profile
// peaks on two Homeys reading the same real physical hardware, despite each raw component
// series matching almost exactly between them; the difference traced to exactly this kind of
// single-hour mismatch. Smoothing each series independently before combining spreads a
// same-side spike a little into its own neighbouring samples, so a same-event spike that
// landed one hour off on a different meter still overlaps and partially cancels, instead of
// producing a hard single-sample artifact. This trades a small amount of edge sharpness for
// robustness against cross-meter timing skew - the final weekly profile already has its own
// smoothing pass, so this only needs to be light.
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

module.exports = {
  findClosestSample, fetchYesterdayAndToday, convertCumulativeToPower, smoothTimeSeries,
};
