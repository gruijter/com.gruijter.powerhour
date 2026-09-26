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

// How the car is used, learned per calendar day: km driven, energy used, when it left home and
// came back. The weekly profile (which weekdays are regular driving days, how much energy they
// need, when the car leaves) is derived from the last MAX_DAYS days. Pure: the device feeds trips
// and day boundaries, and stores the model.
//
// Trips come from car reports: a report with a higher odometer than the previous one ends one or
// more trips. Car apps may only report after a trip, so the departure time is the report time
// minus an estimated driving time, unless the charger saw the cable being pulled shortly before.

const TimeHelpers = require('../helpers/TimeHelpers');

// Bump when stored models must be rebuilt from history (a learning rule changed).
const MODEL_VERSION = 3;
const MAX_DAYS = 84; // 12 weeks
const MIN_WEEKS = 3; // observations of a weekday before it can be called regular
const REGULAR_SHARE = 0.7; // share of observed weekdays with driving to call it regular
const USE_MIN_KM = 1;
const USE_MIN_KWH = 0.5;
const NEED_PERCENTILE = 0.8; // "safe" energy need of a driving day
const DEPARTURE_PERCENTILE = 0.2; // early side of the observed departure times
const AVG_TRIP_SPEED_KMH = 40; // to estimate the departure from a report after the trip
const DEFAULT_KWH_PER_KM = 0.17;
const KWH_PER_KM_ALPHA = 0.2;
const KWH_PER_KM_MIN_TRIP_KM = 10; // shorter trips: SoC rounding dominates the measurement
const KWH_PER_KM_RANGE = [0.08, 0.4];
const KWH_PER_KM_MIN_SAMPLES = 3;
// Days without any odometer change before this many in a row are trusted as "not used". Longer
// runs are more likely a car app that did not report (the km then show up as one jump after).
const MAX_TRUSTED_IDLE_DAYS = 2;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Day-of-week index (0=Monday, 6=Sunday) in local time.
 */
const getDowLocal = (date, timezone) => {
  const localStr = date.toLocaleString('en-US', { weekday: 'long', timeZone: timezone });
  const idx = DAY_NAMES.findIndex((d) => d === localStr);
  return idx >= 0 ? idx : (date.getDay() + 6) % 7;
};

/**
 * Fractional hour in local time (08:30 -> 8.5).
 */
const toLocalFractionalHour = (date, timezone) => {
  const local = TimeHelpers.toLocalDate(date, timezone);
  return local.getHours() + local.getMinutes() / 60 + local.getSeconds() / 3600;
};

/**
 * Local calendar date as YYYY-MM-DD.
 */
const localDateStr = (date, timezone) => {
  const local = TimeHelpers.toLocalDate(date, timezone);
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${m}-${d}`;
};

const fractionalHourToHHMM = (fh) => {
  const total = Math.round(fh * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ─── Model ────────────────────────────────────────────────────────────────────

const newDay = (date, dow, partial = false) => ({
  date,
  dow,
  km: 0,
  socKwh: 0, // energy used according to the car's SoC, summed over trips
  departFh: null, // first departure from home
  returnFh: null, // last return home
  away: false, // left home (known without odometer too, e.g. from a wallbox plug state)
  override: null, // set by the user for this day (e.g. 'boost', 'unused'): not a normal day
  partial, // not observed for the whole day: excluded from the profile
});

const createModel = () => ({
  version: MODEL_VERSION,
  days: [], // finished days, oldest first
  current: null, // the day being recorded
  kwhPerKm: null,
  kwhPerKmSamples: 0,
  lastOdo: null, // odometer at the last car report, to find trips
});

/**
 * Close the current day when the local date changed, and start the new one. A day the model did
 * not see start (first day, or started late after an app restart) is partial: its trips count for
 * kWh/km, not for the weekly profile.
 *
 * @param {boolean|null} [fullDay] - force the new day full (true) or partial (false)
 * @returns {boolean} true when a day was closed
 */
const rollover = (model, now, timezone, fullDay = null) => {
  const date = localDateStr(now, timezone);
  if (model.current && model.current.date === date) return false;
  const closed = !!model.current;
  if (closed) {
    model.days.push(model.current);
    if (model.days.length > MAX_DAYS) model.days.splice(0, model.days.length - MAX_DAYS);
  }
  const partial = fullDay === null ? toLocalFractionalHour(now, timezone) > 0.25 : !fullDay;
  model.current = newDay(date, getDowLocal(now, timezone), partial);
  return closed;
};

/**
 * Roll over to the day of `tm`, creating every day in between as fully observed: in history a day
 * without trips is a day the car was not used.
 */
const rolloverTo = (model, tm, timezone) => {
  const dates = [];
  let cursor = new Date(tm.getTime());
  while (model.current && localDateStr(cursor, timezone) > model.current.date) {
    dates.unshift(cursor);
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);
  }
  dates.forEach((d) => rollover(model, d, timezone, true));
};

/**
 * One or more trips ended with this car report.
 *
 * @param {object} model
 * @param {object} trip
 * @param {number} trip.km - odometer increase since the previous report
 * @param {number|null} trip.kwh - energy used according to the SoC (estimate before - reported)
 * @param {Date} trip.reportTm - time of the report (end of the trip)
 * @param {boolean|null} trip.fromHome - the car was at home before the trip
 * @param {boolean|null} trip.toHome - the car is at home now
 * @param {Date|null} [trip.unplugTm] - cable pulled while charging, shortly before the trip
 * @param {boolean} [trip.coarse] - from coarse history: km only, no timing or kWh/km
 * @param {string} timezone
 */
const recordTrip = (model, trip, timezone) => {
  if (!model.current) rollover(model, trip.reportTm, timezone);
  const day = model.current;
  const km = Math.max(0, Number(trip.km) || 0);
  day.km = Math.round((day.km + km) * 10) / 10;
  if (km > 0) day.away = true;
  if (typeof trip.kwh === 'number' && trip.kwh > 0) day.socKwh = Math.round((day.socKwh + trip.kwh) * 100) / 100;

  // kWh/km, only over trips long enough for the SoC step to mean something.
  if (!trip.coarse && km >= KWH_PER_KM_MIN_TRIP_KM && typeof trip.kwh === 'number') {
    const ratio = trip.kwh / km;
    if (ratio >= KWH_PER_KM_RANGE[0] && ratio <= KWH_PER_KM_RANGE[1]) {
      model.kwhPerKm = model.kwhPerKmSamples === 0
        ? ratio
        : model.kwhPerKm * (1 - KWH_PER_KM_ALPHA) + ratio * KWH_PER_KM_ALPHA;
      model.kwhPerKmSamples += 1;
    }
  }

  if (!trip.coarse && trip.fromHome !== false && day.departFh === null && km > 0) {
    const driveMs = (km / AVG_TRIP_SPEED_KMH) * 3600 * 1000;
    let departTm = new Date(trip.reportTm.getTime() - driveMs);
    // A pulled cable is exact, if it fits before the trip.
    if (trip.unplugTm && trip.unplugTm <= trip.reportTm && (trip.reportTm - trip.unplugTm) < driveMs * 3 + 3600 * 1000) {
      departTm = trip.unplugTm;
    }
    // Only when the trip started today; a trip reported after midnight started yesterday.
    if (localDateStr(departTm, timezone) === day.date) day.departFh = toLocalFractionalHour(departTm, timezone);
  }
  if (!trip.coarse && trip.toHome === true) day.returnFh = toLocalFractionalHour(trip.reportTm, timezone);
  return model;
};

/**
 * Departure or return seen live, for chargers and cars without odometer (a wallbox plug state, the
 * power-gap fallback). The day counts as a driving day; its energy stays unknown.
 */
const recordAway = (model, { departTm = null, returnTm = null }, timezone) => {
  const tm = departTm || returnTm;
  if (!tm) return model;
  if (!model.current) rollover(model, tm, timezone);
  const day = model.current;
  day.away = true;
  if (departTm && day.departFh === null && localDateStr(departTm, timezone) === day.date) {
    day.departFh = toLocalFractionalHour(departTm, timezone);
  }
  if (returnTm) day.returnFh = toLocalFractionalHour(returnTm, timezone);
  return model;
};

const setOverride = (model, override) => {
  if (model.current) model.current.override = override;
  return model;
};

// ─── Derived weekly profile ───────────────────────────────────────────────────

const effectiveKwhPerKm = (model) => (model.kwhPerKmSamples >= KWH_PER_KM_MIN_SAMPLES ? model.kwhPerKm : null);

/**
 * Energy a day used: from km when the consumption per km is learned (the SoC is an integer, too
 * coarse for a short commute), else from the SoC.
 */
const dayKwh = (day, kwhPerKm) => {
  if (day.km > 0 && typeof kwhPerKm === 'number') return day.km * kwhPerKm;
  if (day.socKwh > 0) return day.socKwh;
  return day.km * DEFAULT_KWH_PER_KM;
};

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * Per weekday (0=Monday): observed days, driving days, share, whether it is a regular driving day,
 * typical and safe energy need (kWh), early departure time and typical return time (fractional h).
 */
const getProfile = (model) => {
  const kwhPerKm = effectiveKwhPerKm(model);
  const profile = [];
  for (let dow = 0; dow < 7; dow += 1) {
    const days = model.days.filter((d) => d.dow === dow && !d.partial && !d.override);
    const used = days.filter((d) => d.away || d.km >= USE_MIN_KM || d.socKwh >= USE_MIN_KWH);
    const kwh = used.filter((d) => d.km > 0 || d.socKwh > 0).map((d) => dayKwh(d, kwhPerKm)).sort((a, b) => a - b);
    const departs = used.map((d) => d.departFh).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const returns = used.map((d) => d.returnFh).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const share = days.length ? used.length / days.length : null;
    const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
    profile.push({
      dow,
      observed: days.length,
      used: used.length,
      share,
      regular: days.length >= MIN_WEEKS && share >= REGULAR_SHARE,
      needKwh: round1(quantile(kwh, 0.5)),
      safeKwh: round1(quantile(kwh, NEED_PERCENTILE)),
      departFh: quantile(departs, DEPARTURE_PERCENTILE),
      returnFh: quantile(returns, 0.5),
    });
  }
  return profile;
};

// ─── Bootstrap from history ───────────────────────────────────────────────────

/**
 * Largest odometer step that can be one trip: a full battery at the default consumption.
 */
const maxTripKm = (capacityKwh) => (capacityKwh > 0 ? capacityKwh / DEFAULT_KWH_PER_KM : Infinity);

/**
 * History can hide periods where the car app did not report: the odometer stands still, then
 * jumps. Such idle runs, the jump day after them, and days with more km than a full battery
 * allows are marked partial: they would teach "not used" and one impossible trip.
 */
const markReportingGaps = (days, capacityKwh) => {
  const maxKm = maxTripKm(capacityKwh);
  let run = [];
  days.forEach((d) => {
    if (d.km > 0) {
      if (run.length > MAX_TRUSTED_IDLE_DAYS) {
        run.forEach((r) => {
          r.partial = true;
        });
        d.partial = true;
      }
      if (d.km > maxKm) d.partial = true;
      run = [];
    } else if (!d.partial) {
      run.push(d);
    } else {
      run = [];
    }
  });
  // A trailing idle run is only known to be idle up to now: same rule.
  if (run.length > MAX_TRUSTED_IDLE_DAYS) {
    run.forEach((r) => {
      r.partial = true;
    });
  }
};

/**
 * The car app was unreachable during the current day: its trips may be missed or merged.
 */
const markCurrentUnobserved = (model) => {
  if (model.current) model.current.partial = true;
  return model;
};

/**
 * Build a model from Insights history: the car's odometer (required) and SoC (optional). Hourly
 * points are enough: a trip shows as an odometer step in the hour its report came in. Entries
 * marked coarse (Insights gives only 6-hour points beyond 14 days) give km per day only.
 *
 * @param {Array<{t:number, v:number, coarse?:boolean}>} odoEntries
 * @param {Array<{t:number, v:number}>|null} socEntries
 * @param {number} capacityKwh
 * @param {string} timezone
 * @param {Date} now
 */
const bootstrapFromHistory = (odoEntries, socEntries, capacityKwh, timezone, now = new Date()) => {
  const model = createModel();
  const odo = (odoEntries || []).filter((e) => typeof e.v === 'number' && e.v > 0).sort((a, b) => a.t - b.t);
  if (odo.length < 2) return model;
  const soc = (socEntries || []).filter((e) => typeof e.v === 'number').sort((a, b) => a.t - b.t);
  const socAt = (t, before) => {
    // last SoC at or before t (before=true), or first after t
    let best = null;
    for (const e of soc) {
      if (before && e.t <= t) best = e.v;
      if (!before && e.t >= t) return e.v;
    }
    return best;
  };

  rollover(model, new Date(odo[0].t), timezone, false); // starts at an arbitrary moment
  // Hourly values are hour averages: one odometer step spreads over two consecutive hours.
  // Consecutive increases are one trip, reported at the first of them.
  let i = 1;
  while (i < odo.length) {
    const start = odo[i - 1];
    if (odo[i].v - start.v < 0.1) {
      i += 1;
      continue;
    }
    const first = odo[i];
    while (i + 1 < odo.length && odo[i + 1].v - odo[i].v >= 0.1) i += 1;
    const end = odo[i];
    const reportTm = new Date(first.t);
    rolloverTo(model, reportTm, timezone);
    const km = end.v - start.v;
    if (km < 2000) {
      const before = socAt(start.t, true);
      const after = socAt(end.t, false);
      const kwh = (typeof before === 'number' && typeof after === 'number' && before > after)
        ? ((before - after) / 100) * capacityKwh : null;
      recordTrip(model, {
        km, kwh, reportTm, fromHome: null, toHome: null, coarse: !!(start.coarse || end.coarse),
      }, timezone);
    }
    i += 1;
  }
  rolloverTo(model, now, timezone);
  // No lastOdo from history: hourly values are hour averages, so the last one can lie anywhere
  // between the old and the new odometer. The caller sets it from the live car.
  markReportingGaps(model.current ? model.days.concat([model.current]) : model.days, capacityKwh);
  // A day without any logged value was not observed (Insights gap), not a day without driving.
  const covered = new Set(odo.map((e) => localDateStr(new Date(e.t), timezone)));
  model.days.forEach((d) => {
    if (!covered.has(d.date)) d.partial = true;
  });
  return model;
};

/**
 * Merge a fresh bootstrap with the live model: live days win, history fills in before them.
 */
const mergeBootstrap = (live, boot) => {
  if (!live || (!live.days.length && !live.current)) return boot;
  const firstLive = live.days.length ? live.days[0].date : live.current.date;
  return {
    ...live,
    days: boot.days.filter((d) => d.date < firstLive).concat(live.days).slice(-MAX_DAYS),
    kwhPerKm: live.kwhPerKmSamples ? live.kwhPerKm : boot.kwhPerKm,
    kwhPerKmSamples: live.kwhPerKmSamples || boot.kwhPerKmSamples,
    lastOdo: typeof live.lastOdo === 'number' ? live.lastOdo : boot.lastOdo,
  };
};

/**
 * A stored model, or null when it was made by an older version and must be rebuilt.
 */
const fromStore = (stored) => (stored && stored.version === MODEL_VERSION ? stored : null);

module.exports = {
  fromStore,
  mergeBootstrap,
  createModel,
  rollover,
  recordTrip,
  recordAway,
  setOverride,
  markCurrentUnobserved,
  maxTripKm,
  getProfile,
  dayKwh,
  effectiveKwhPerKm,
  bootstrapFromHistory,
  getDowLocal,
  toLocalFractionalHour,
  localDateStr,
  fractionalHourToHHMM,
  DAY_NAMES,
  DEFAULT_KWH_PER_KM,
  MAX_DAYS,
};
