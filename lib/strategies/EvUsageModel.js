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
// Reports from leaving home until back home form one round trip. Only a round trip that used at
// least the minimum SoC counts as driving: errands are not learned. Per weekday, round trips that
// leave within SAME_TRIP_HOURS of each other are the same trip; a trip made on most of those
// weekdays is planned with its own departure and need.

const TimeHelpers = require('../helpers/TimeHelpers');
const { HOME_RADIUS_KM } = require('./EvPresence');

// Bump when stored models must be rebuilt from history (a learning rule changed).
const MODEL_VERSION = 5;
const MAX_DAYS = 84; // 12 weeks
const MIN_WEEKS = 3; // observations of a weekday before it can be called regular
const REGULAR_SHARE = 0.7; // share of observed weekdays with driving to call it regular
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
// The car further than this from home at night: away overnight (holiday, a stay elsewhere). The
// day it left and the day it came back are not normal days either: none of them is learned.
const AWAY_NIGHT_KM = 1;
const NIGHT_HOUR = 3; // local hour at which the car's last known distance counts for the night
const SAME_TRIP_HOURS = 3;
const DEFAULT_MIN_TRIP_SOC = 3; // % of the battery a round trip must use to count as driving

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
  override: null, // set by the user for this day (e.g. 'min', 'unused'): not a normal day
  awayNight: false, // the car was away at the start or end of the day: not a normal day
  partial, // not observed for the whole day: excluded from the profile
  outings: [], // round trips from home that left this day: {departFh, returnFh, km, socKwh}
});

const createModel = () => ({
  version: MODEL_VERSION,
  days: [], // finished days, oldest first
  current: null, // the day being recorded
  kwhPerKm: null,
  kwhPerKmSamples: 0,
  lastOdo: null, // odometer at the last car report, to find trips
  outing: null, // round trip in progress: {date, departFh, km, socKwh}
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
 * The round trip in progress ended at home: store it with the day it left.
 */
const closeOuting = (model, returnTm, timezone) => {
  const o = model.outing;
  model.outing = null;
  if (!o) return null;
  const day = [model.current, ...model.days].find((d) => d && d.date === o.date);
  const outing = {
    departFh: o.departFh,
    returnFh: returnTm && localDateStr(returnTm, timezone) === o.date ? toLocalFractionalHour(returnTm, timezone) : null,
    km: o.km,
    socKwh: o.socKwh,
  };
  if (day) {
    if (!Array.isArray(day.outings)) day.outings = [];
    day.outings.push(outing);
  }
  return outing;
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
 * @returns {object|null} the round trip this report ended at home
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

  const estimateDepart = () => {
    const driveMs = (km / AVG_TRIP_SPEED_KMH) * 3600 * 1000;
    // A pulled cable is exact, if it fits before the trip.
    if (trip.unplugTm && trip.unplugTm <= trip.reportTm && (trip.reportTm - trip.unplugTm) < driveMs * 3 + 3600 * 1000) {
      return trip.unplugTm;
    }
    return new Date(trip.reportTm.getTime() - driveMs);
  };
  if (!trip.coarse && trip.fromHome !== false && day.departFh === null && km > 0) {
    const departTm = estimateDepart();
    // Only when the trip started today; a trip reported after midnight started yesterday.
    if (localDateStr(departTm, timezone) === day.date) day.departFh = toLocalFractionalHour(departTm, timezone);
  }
  if (!trip.coarse && trip.toHome === true) day.returnFh = toLocalFractionalHour(trip.reportTm, timezone);

  // Round trips need to know where the car was: without it the day counts as a whole.
  if (trip.coarse || km <= 0 || (trip.fromHome !== true && trip.fromHome !== false && trip.toHome !== true && trip.toHome !== false)) return null;
  // Leaving home with one still open: its return was not reported.
  if (trip.fromHome === true && model.outing) closeOuting(model, null, timezone);
  if (!model.outing) {
    const departTm = trip.fromHome === true ? estimateDepart() : null;
    model.outing = {
      date: departTm ? localDateStr(departTm, timezone) : day.date,
      departFh: departTm ? toLocalFractionalHour(departTm, timezone) : null,
      km: 0,
      socKwh: 0,
    };
  }
  model.outing.km = Math.round((model.outing.km + km) * 10) / 10;
  if (typeof trip.kwh === 'number' && trip.kwh > 0) model.outing.socKwh = Math.round((model.outing.socKwh + trip.kwh) * 100) / 100;
  return trip.toHome === true ? closeOuting(model, trip.reportTm, timezone) : null;
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

/**
 * The car is away from home at the day change: the day that ended and the new one are not normal.
 * Call right after rollover() closed a day.
 */
const markAwayNight = (model) => {
  const last = model.days[model.days.length - 1];
  if (last) last.awayNight = true;
  if (model.current) model.current.awayNight = true;
  return model;
};

/**
 * Parse away periods: 'YYYY-MM-DD/YYYY-MM-DD' (or DD-MM-YYYY, a single date for one day), separated
 * by commas, semicolons or new lines.
 * @returns {Array<{from: string, to: string}>|null} null: not valid
 */
const parsePeriods = (text) => {
  const iso = (v) => {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(v);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  };
  const periods = [];
  const parts = String(text || '').split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const [a, b, extra] = part.split('/').map((v) => v.trim());
    const from = iso(a);
    const to = b === undefined ? from : iso(b);
    if (!from || !to || extra !== undefined || to < from) return null;
    periods.push({ from, to });
  }
  return periods;
};

const inPeriods = (date, periods) => (periods || []).some((p) => date >= p.from && date <= p.to);

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

/**
 * Energy a round trip must use to count as driving (kWh).
 * @param {number} minTripSoc - %
 */
const minTripKwh = (minTripSoc, capacityKwh) => {
  const pct = Number.isFinite(Number(minTripSoc)) ? Math.max(0, Number(minTripSoc)) : DEFAULT_MIN_TRIP_SOC;
  return (pct / 100) * (capacityKwh > 0 ? capacityKwh : 50);
};

/**
 * The driving of a day that counts: [{departFh, returnFh, kwh}]. Days recorded with the car's
 * location have round trips; others count as one trip (times and energy may be unknown).
 */
const dayTrips = (day, kwhPerKm, minKwh) => {
  if (Array.isArray(day.outings) && day.outings.length) {
    return day.outings.map((o) => ({ departFh: o.departFh, returnFh: o.returnFh, kwh: dayKwh(o, kwhPerKm) }))
      .filter((t) => t.kwh >= minKwh);
  }
  const hasEnergy = day.km > 0 || day.socKwh > 0;
  const kwh = hasEnergy ? dayKwh(day, kwhPerKm) : null;
  if (hasEnergy ? kwh < minKwh : !day.away) return [];
  return [{ departFh: day.departFh, returnFh: day.returnFh, kwh }];
};

/**
 * Index of the learned trip ([{departFh}]) nearest to departFh, within SAME_TRIP_HOURS; -1 for none.
 */
const nearestTrip = (trips, departFh) => {
  let best = -1;
  (trips || []).forEach((t, i) => {
    const dist = Math.abs(t.departFh - departFh);
    if (dist <= SAME_TRIP_HOURS && (best < 0 || dist < Math.abs(trips[best].departFh - departFh))) best = i;
  });
  return best;
};

/**
 * Round trips that count as driving and ended at home today: [{departFh}].
 */
const tripsToday = (model, minKwh) => {
  if (!model || !model.current) return [];
  const kwhPerKm = effectiveKwhPerKm(model);
  return (model.current.outings || []).filter((o) => dayKwh(o, kwhPerKm) >= minKwh).map((o) => ({ departFh: o.departFh }));
};

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// An observed value: interpolating times of a morning and an evening trip gives a time no trip had.
const quantileObserved = (sorted, q) => (sorted.length ? sorted[Math.round((sorted.length - 1) * q)] : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const sorted = (values) => values.filter((v) => typeof v === 'number').sort((a, b) => a - b);

/**
 * The regular trips of one weekday from its timed driving: [{departFh, returnFh, needKwh, safeKwh,
 * share}], by departure. Only days with known times count: a driving day without times says
 * nothing about which trip it was.
 * @param {Array<{date, trips}>} days - normal days of the weekday, trips from dayTrips()
 */
const regularTrips = (days) => {
  const timed = days.filter((d) => !d.trips.length || d.trips.some((t) => typeof t.departFh === 'number'));
  if (timed.length < MIN_WEEKS) return [];
  const all = [];
  timed.forEach((d) => d.trips.forEach((t) => {
    if (typeof t.departFh === 'number') all.push({ ...t, date: d.date });
  }));
  all.sort((a, b) => a.departFh - b.departFh);
  const groups = [];
  all.forEach((t) => {
    const g = groups[groups.length - 1];
    if (g && t.departFh - g[0].departFh <= SAME_TRIP_HOURS) g.push(t);
    else groups.push([t]);
  });
  const out = [];
  groups.forEach((g) => {
    // Several round trips of one day in the same trip: one trip of that day.
    const byDate = new Map();
    g.forEach((t) => {
      const m = byDate.get(t.date);
      if (!m) {
        byDate.set(t.date, { ...t });
        return;
      }
      if (typeof t.returnFh === 'number') m.returnFh = Math.max(m.returnFh || 0, t.returnFh);
      if (typeof t.kwh === 'number') m.kwh = (m.kwh || 0) + t.kwh;
    });
    const perDay = [...byDate.values()];
    const share = perDay.length / timed.length;
    if (share < REGULAR_SHARE) return;
    const kwh = sorted(perDay.map((t) => t.kwh));
    out.push({
      departFh: quantileObserved(sorted(perDay.map((t) => t.departFh)), DEPARTURE_PERCENTILE),
      returnFh: quantileObserved(sorted(perDay.map((t) => t.returnFh)), 0.5),
      needKwh: round1(quantile(kwh, 0.5)),
      safeKwh: round1(quantile(kwh, NEED_PERCENTILE)),
      share,
    });
  });
  return out;
};

/**
 * Per weekday (0=Monday): observed days, driving days, share, whether it is a regular driving day,
 * typical and safe energy need of the day (kWh), early departure time and typical return time
 * (fractional h), its regular trips (regularTrips()), and the days not learned by reason
 * ({override, period, awayNight, partial}: count).
 * Days away overnight and days in the user's away periods are not normal days: not learned.
 * @param {object} model
 * @param {Array<{from, to}>} [awayPeriods] - parsePeriods()
 * @param {number} [minKwh] - round trips that used less are not driving (minTripKwh())
 */
const getProfile = (model, awayPeriods = [], minKwh = 0) => {
  const kwhPerKm = effectiveKwhPerKm(model);
  const profile = [];
  for (let dow = 0; dow < 7; dow += 1) {
    // Days not learned, by the first reason that applies (shown with the profile).
    const skipped = {};
    const days = model.days.filter((d) => {
      if (d.dow !== dow) return false;
      let why = null;
      if (d.override) why = 'override';
      else if (inPeriods(d.date, awayPeriods)) why = 'period';
      else if (d.awayNight) why = 'awayNight';
      else if (d.partial) why = 'partial';
      if (why) skipped[why] = (skipped[why] || 0) + 1;
      return !why;
    });
    const withTrips = days.map((d) => ({ date: d.date, d, trips: dayTrips(d, kwhPerKm, minKwh) }));
    const uses = withTrips.filter((u) => u.trips.length);
    const used = uses.map((u) => u.d);
    const kwh = sorted(used.filter((d) => d.km > 0 || d.socKwh > 0).map((d) => dayKwh(d, kwhPerKm)));
    const departs = sorted(uses.map((u) => u.trips.find((t) => typeof t.departFh === 'number')).map((t) => t && t.departFh));
    const returns = sorted(uses.map((u) => u.trips.filter((t) => typeof t.returnFh === 'number').pop()).map((t) => t && t.returnFh));
    const trips = regularTrips(withTrips);
    const share = days.length ? used.length / days.length : null;
    profile.push({
      dow,
      observed: days.length,
      used: used.length,
      share,
      regular: (days.length >= MIN_WEEKS && share >= REGULAR_SHARE) || trips.length > 0,
      needKwh: round1(quantile(kwh, 0.5)),
      safeKwh: round1(quantile(kwh, NEED_PERCENTILE)),
      departFh: trips.length ? trips[0].departFh : quantileObserved(departs, DEPARTURE_PERCENTILE),
      returnFh: trips.length ? trips[trips.length - 1].returnFh : quantileObserved(returns, 0.5),
      trips,
      skipped,
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
 * @param {Array<{t:number, km:number}>|null} [distEntries] - the car's distance from home (location
 *   history): away overnight marks the days around that night
 */
const bootstrapFromHistory = (odoEntries, socEntries, capacityKwh, timezone, now = new Date(), distEntries = null) => {
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

  // Where the car was, from its distance history: hour averages, so the hour before a trip and
  // the hour after it are checked too.
  const dist = (distEntries || []).filter((e) => typeof e.km === 'number').sort((a, b) => a.t - b.t);
  const distAt = (t) => {
    let best = null;
    for (const e of dist) {
      if (e.t > t) break;
      best = e.km;
    }
    return best;
  };
  const homeAt = (t, stepMs) => {
    const v = [distAt(t), distAt(t + stepMs)].filter((x) => typeof x === 'number');
    return v.length ? v.some((x) => x <= HOME_RADIUS_KM) : null;
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
      const coarse = !!(start.coarse || end.coarse);
      recordTrip(model, {
        km,
        kwh,
        reportTm,
        fromHome: coarse ? null : homeAt(start.t, -3600 * 1000),
        toHome: coarse ? null : homeAt(end.t, 3600 * 1000),
        coarse,
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
    d.history = true; // from Insights: a later bootstrap may replace it (mergeBootstrap)
  });
  // Away overnight: the car's last known distance at NIGHT_HOUR. Insights only logs a change: a car
  // parked elsewhere logs nothing for days, and coming home logs the change back. The night belongs
  // to the day it ends and the day before.
  if (dist.length) {
    const all = model.current ? model.days.concat([model.current]) : model.days;
    let k = -1;
    all.forEach((d, idx) => {
      const nightTm = TimeHelpers.getLocalMidnightUTC(new Date(`${d.date}T12:00:00Z`), timezone).getTime() + NIGHT_HOUR * 3600 * 1000;
      while (k + 1 < dist.length && dist[k + 1].t <= nightTm) k += 1;
      const last = k >= 0 ? dist[k] : null;
      if (!last || !(last.km > AWAY_NIGHT_KM)) return;
      d.awayNight = true;
      if (idx > 0) all[idx - 1].awayNight = true;
    });
  }
  return model;
};

/**
 * Merge a fresh bootstrap with the live model: days recorded live win, the fresh history replaces
 * the history of an earlier bootstrap, and older history the fresh one no longer reaches stays.
 */
const mergeBootstrap = (live, boot) => {
  if (!live || (!live.days.length && !live.current)) return boot;
  const byDate = new Map();
  live.days.filter((d) => d.history).forEach((d) => byDate.set(d.date, d));
  boot.days.forEach((d) => byDate.set(d.date, d));
  live.days.filter((d) => !d.history).forEach((d) => byDate.set(d.date, d));
  if (live.current) byDate.delete(live.current.date);
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...live,
    days: days.slice(-MAX_DAYS),
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
  markAwayNight,
  parsePeriods,
  inPeriods,
  markCurrentUnobserved,
  maxTripKm,
  getProfile,
  minTripKwh,
  tripsToday,
  nearestTrip,
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
  AWAY_NIGHT_KM,
  DEFAULT_MIN_TRIP_SOC,
  SAME_TRIP_HOURS,
};
