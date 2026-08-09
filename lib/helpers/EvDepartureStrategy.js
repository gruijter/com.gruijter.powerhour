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

// Exponentially weighted moving average weight.
// alpha=0.2 means each new observation contributes 20%, prior model 80%.
// After ~10 sessions the model is stable; recent corrections phase in within 2-3 sessions.
const EWA_ALPHA = 0.2;

// Minimum gap (ms) between two Insights power readings to count as a session boundary.
const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

// Days of the week labels (0=Monday, 6=Sunday)
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Return the day-of-week index (0=Monday, 6=Sunday) in local time for a given Date.
 */
const getDowLocal = (date, timezone) => {
  const localStr = date.toLocaleString('en-US', { weekday: 'long', timeZone: timezone });
  const idx = DAY_NAMES.findIndex((d) => d === localStr);
  return idx >= 0 ? idx : (date.getDay() + 6) % 7; // fallback: convert JS Sun=0..Sat=6 to Mon=0..Sun=6
};

/**
 * Convert a Date to a fractional hour in local time (e.g. 08:30 -> 8.5).
 */
const toLocalFractionalHour = (date, timezone) => {
  const local = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return local.getHours() + local.getMinutes() / 60 + local.getSeconds() / 3600;
};

/**
 * Convert a fractional hour to "HH:MM" string.
 */
const fractionalHourToHHMM = (fh) => {
  const total = Math.round(fh * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
};

/**
 * Create a default empty per-day model entry.
 */
const emptyDay = () => ({
  learnedDepartureTime: null, // "HH:MM" or null if not yet learned
  learnedReturnTime: null,
  learnedDepartureSoc: null, // % or null
  learnedReturnSoc: null,
  learnedTripKwh: null,
  sessionCount: 0,
  // raw EWA accumulators (fractional hours / percent)
  _depFh: null,
  _retFh: null,
  _depSoc: null,
  _retSoc: null,
});

/**
 * Create a fresh 7-day model (one entry per day, 0=Monday, 6=Sunday).
 */
const createModel = () => Array.from({ length: 7 }, emptyDay);

/**
 * Apply one EWA update to a value accumulator.
 * If accumulator is null (first observation), the new value seeds it directly.
 */
const ewaUpdate = (current, newValue, alpha) => {
  const a = alpha !== undefined ? alpha : EWA_ALPHA;
  if (current === null || current === undefined) return newValue;
  return current * (1 - a) + newValue * a;
};

/**
 * Record a departure event (car disconnected) for a given day-of-week.
 */
const recordDeparture = (model, dow, departureFh, departureSoc, batCapacity) => {
  const day = model[dow];
  day._depFh = ewaUpdate(day._depFh, departureFh);
  day.learnedDepartureTime = fractionalHourToHHMM(day._depFh);

  if (typeof departureSoc === 'number') {
    day._depSoc = ewaUpdate(day._depSoc, departureSoc);
    day.learnedDepartureSoc = Math.round(day._depSoc);
  }

  // Compute trip kWh if we have both departure and return SoC
  if (day._depSoc !== null && day._retSoc !== null && batCapacity > 0) {
    const tripKwh = Math.max(0, (day._depSoc - day._retSoc) / 100) * batCapacity;
    day.learnedTripKwh = Math.round(tripKwh * 10) / 10;
  }

  day.sessionCount += 1;
  return model;
};

/**
 * Record a return event (car connected / new charge session started) for a given day-of-week.
 */
const recordReturn = (model, dow, returnFh, returnSoc) => {
  const day = model[dow];
  day._retFh = ewaUpdate(day._retFh, returnFh);
  day.learnedReturnTime = fractionalHourToHHMM(day._retFh);

  if (typeof returnSoc === 'number') {
    day._retSoc = ewaUpdate(day._retSoc, returnSoc);
    day.learnedReturnSoc = Math.round(day._retSoc);
  }

  return model;
};

/**
 * Bootstrap a model from Homey Insights history entries.
 * Scans entries for session boundaries (gaps > SESSION_GAP_MS) and records
 * departure/return events. Optional SoC entries improve model accuracy.
 *
 * @param {Array<{t: number, v: number}>} powerEntries - [{t: ms timestamp, v: watts}]
 * @param {Array<{t: number, v: number}>} [socEntries]  - [{t: ms timestamp, v: percent}]
 * @param {string} timezone - IANA timezone string
 * @param {number} batCapacity - battery capacity in kWh
 * @returns {Array} bootstrapped 7-day model
 */
const bootstrapFromHistory = (powerEntries, socEntries, timezone, batCapacity) => {
  const model = createModel();
  if (!powerEntries || powerEntries.length < 2) return model;

  const sorted = [...powerEntries].sort((a, b) => a.t - b.t);

  const socLookup = (ts) => {
    if (!socEntries || socEntries.length === 0) return null;
    const sorted2 = [...socEntries].sort((a, b) => Math.abs(a.t - ts) - Math.abs(b.t - ts));
    const nearest = sorted2[0];
    if (Math.abs(nearest.t - ts) < 15 * 60 * 1000) return nearest.v;
    return null;
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.t - prev.t;
    const wasActive = prev.v > 20;
    const isActive = curr.v > 20;

    if (wasActive && !isActive && gap > SESSION_GAP_MS) {
      const depDate = new Date(prev.t);
      const dow = getDowLocal(depDate, timezone);
      const depFh = toLocalFractionalHour(depDate, timezone);
      const depSoc = socLookup(prev.t);
      recordDeparture(model, dow, depFh, depSoc, batCapacity);
    }

    if (!wasActive && isActive && gap > SESSION_GAP_MS) {
      const retDate = new Date(curr.t);
      const dow = getDowLocal(retDate, timezone);
      const retFh = toLocalFractionalHour(retDate, timezone);
      const retSoc = socLookup(curr.t);
      recordReturn(model, dow, retFh, retSoc);
    }
  }

  return model;
};

/**
 * Get the effective departure time for a given day-of-week.
 * Returns the manually set time if provided (non-empty), otherwise the learned time,
 * otherwise the global fallback.
 */
const getEffectiveDepartureTime = (model, dow, manualTimes, globalFallback) => {
  const fb = globalFallback || '08:00';
  const manual = manualTimes && manualTimes[dow];
  if (manual && manual.trim().length === 5) return manual.trim();
  return (model && model[dow] && model[dow].learnedDepartureTime) || fb;
};

/**
 * Get the predicted return SoC for a given day-of-week.
 * Returns null if no data learned yet (caller should fall back to live SoC).
 */
const getPredictedReturnSoc = (model, dow) => {
  if (!model || !model[dow]) return null;
  return model[dow].learnedReturnSoc;
};

module.exports = {
  DAY_NAMES,
  getDowLocal,
  toLocalFractionalHour,
  fractionalHourToHHMM,
  createModel,
  recordDeparture,
  recordReturn,
  bootstrapFromHistory,
  getEffectiveDepartureTime,
  getPredictedReturnSoc,
  EWA_ALPHA,
  SESSION_GAP_MS,
};
