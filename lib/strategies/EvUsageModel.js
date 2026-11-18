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
const { HOME_RADIUS_KM } = require('./EvPresence');

const MODEL_VERSION = 5;
const MAX_DAYS = 84;
const MIN_WEEKS = 3;
const REGULAR_SHARE = 0.7;
const NEED_PERCENTILE = 0.8;
const SAFE_MIN_SAMPLES = 5;
const FEW_SAMPLES_MARGIN = 1.25;
const OUTLIER_FACTOR = 2;
const DEPARTURE_PERCENTILE = 0.2;
const AVG_TRIP_SPEED_KMH = 40;
const DEFAULT_KWH_PER_KM = 0.17;
const KWH_PER_KM_ALPHA = 0.2;
const KWH_PER_KM_MIN_TRIP_KM = 10;
const KWH_PER_KM_RANGE = [0.08, 0.4];
const KWH_PER_KM_MIN_SAMPLES = 3;
const MAX_TRUSTED_IDLE_DAYS = 2;
const AWAY_NIGHT_KM = 1;
const NIGHT_HOUR = 3;
const SAME_TRIP_HOURS = 3;
const DEFAULT_MIN_TRIP_SOC = 3;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const getDowLocal = (date, timezone) => {
  const localStr = date.toLocaleString('en-US', { weekday: 'long', timeZone: timezone });
  const idx = DAY_NAMES.findIndex((d) => d === localStr);
  return idx >= 0 ? idx : (date.getDay() + 6) % 7;
};

const toLocalFractionalHour = (date, timezone) => {
  const local = TimeHelpers.toLocalDate(date, timezone);
  return local.getHours() + local.getMinutes() / 60 + local.getSeconds() / 3600;
};

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

const newDay = (date, dow, partial = false) => ({
  date,
  dow,
  km: 0,
  socKwh: 0,
  departFh: null,
  returnFh: null,
  away: false,
  override: null,
  awayNight: false,
  partial,
  outings: [],
});

const createModel = () => ({
  version: MODEL_VERSION,
  days: [],
  current: null,
  kwhPerKm: null,
  kwhPerKmSamples: 0,
  lastOdo: null,
  outing: null,
});

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

const rolloverTo = (model, tm, timezone) => {
  const dates = [];
  let cursor = new Date(tm.getTime());
  while (model.current && localDateStr(cursor, timezone) > model.current.date) {
    dates.unshift(cursor);
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);
  }
  dates.forEach((d) => rollover(model, d, timezone, true));
};

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

const recordTrip = (model, trip, timezone) => {
  if (!model.current) rollover(model, trip.reportTm, timezone);
  const day = model.current;
  const km = Math.max(0, Number(trip.km) || 0);
  day.km = Math.round((day.km + km) * 10) / 10;
  if (km > 0) day.away = true;
  if (typeof trip.kwh === 'number' && trip.kwh > 0) day.socKwh = Math.round((day.socKwh + trip.kwh) * 100) / 100;

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
    if (trip.unplugTm && trip.unplugTm <= trip.reportTm && (trip.reportTm - trip.unplugTm) < driveMs * 3 + 3600 * 1000) {
      return trip.unplugTm;
    }
    return new Date(trip.reportTm.getTime() - driveMs);
  };
  if (!trip.coarse && trip.fromHome !== false && day.departFh === null && km > 0) {
    const departTm = estimateDepart();
    if (localDateStr(departTm, timezone) === day.date) day.departFh = toLocalFractionalHour(departTm, timezone);
  }
  if (!trip.coarse && trip.toHome === true) day.returnFh = toLocalFractionalHour(trip.reportTm, timezone);

  if (trip.coarse || km <= 0 || (trip.fromHome !== true && trip.fromHome !== false && trip.toHome !== true && trip.toHome !== false)) return null;
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

const markAwayNight = (model) => {
  const last = model.days[model.days.length - 1];
  if (last) last.awayNight = true;
  if (model.current) model.current.awayNight = true;
  return model;
};

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

const effectiveKwhPerKm = (model) => (model.kwhPerKmSamples >= KWH_PER_KM_MIN_SAMPLES ? model.kwhPerKm : null);

const dayKwh = (day, kwhPerKm) => {
  if (day.km > 0 && typeof kwhPerKm === 'number') return day.km * kwhPerKm;
  if (day.socKwh > 0) return day.socKwh;
  return day.km * DEFAULT_KWH_PER_KM;
};

const minTripKwh = (minTripSoc, capacityKwh) => {
  const pct = Number.isFinite(Number(minTripSoc)) ? Math.max(0, Number(minTripSoc)) : DEFAULT_MIN_TRIP_SOC;
  return (pct / 100) * (capacityKwh > 0 ? capacityKwh : 50);
};

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

const nearestTrip = (trips, departFh) => {
  let best = -1;
  (trips || []).forEach((t, i) => {
    const dist = Math.abs(t.departFh - departFh);
    if (dist <= SAME_TRIP_HOURS && (best < 0 || dist < Math.abs(trips[best].departFh - departFh))) best = i;
  });
  return best;
};

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

const quantileObserved = (sorted, q) => (sorted.length ? sorted[Math.round((sorted.length - 1) * q)] : null);
const safeNeed = (kwh) => {
  const median = quantile(kwh, 0.5);
  if (median === null) return null;
  if (kwh.length < SAFE_MIN_SAMPLES) return Math.min(quantile(kwh, NEED_PERCENTILE), median * FEW_SAMPLES_MARGIN);
  return quantile(kwh.map((v) => Math.min(v, median * OUTLIER_FACTOR)), NEED_PERCENTILE);
};
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const sorted = (values) => values.filter((v) => typeof v === 'number').sort((a, b) => a - b);

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
      safeKwh: round1(safeNeed(kwh)),
      share,
    });
  });
  return out;
};

const getProfile = (model, awayPeriods = [], minKwh = 0) => {
  const kwhPerKm = effectiveKwhPerKm(model);
  const profile = [];
  for (let dow = 0; dow < 7; dow += 1) {
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
      safeKwh: round1(safeNeed(kwh)),
      departFh: trips.length ? trips[0].departFh : quantileObserved(departs, DEPARTURE_PERCENTILE),
      returnFh: trips.length ? trips[trips.length - 1].returnFh : quantileObserved(returns, 0.5),
      trips,
      skipped,
    });
  }
  return profile;
};

const maxTripKm = (capacityKwh) => (capacityKwh > 0 ? capacityKwh / DEFAULT_KWH_PER_KM : Infinity);

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
  if (run.length > MAX_TRUSTED_IDLE_DAYS) {
    run.forEach((r) => {
      r.partial = true;
    });
  }
};

const markCurrentUnobserved = (model) => {
  if (model.current) model.current.partial = true;
  return model;
};

const bootstrapFromHistory = (odoEntries, socEntries, capacityKwh, timezone, now = new Date(), distEntries = null) => {
  const model = createModel();
  const odo = (odoEntries || []).filter((e) => typeof e.v === 'number' && e.v > 0).sort((a, b) => a.t - b.t);
  if (odo.length < 2) return model;
  const soc = (socEntries || []).filter((e) => typeof e.v === 'number').sort((a, b) => a.t - b.t);
  const socAt = (t, before) => {
    let best = null;
    for (const e of soc) {
      if (before && e.t <= t) best = e.v;
      if (!before && e.t >= t) return e.v;
    }
    return best;
  };

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

  rollover(model, new Date(odo[0].t), timezone, false);
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
  markReportingGaps(model.current ? model.days.concat([model.current]) : model.days, capacityKwh);
  const covered = new Set(odo.map((e) => localDateStr(new Date(e.t), timezone)));
  model.days.forEach((d) => {
    if (!covered.has(d.date)) d.partial = true;
    d.history = true;
  });
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

const fromStore = (stored) => (stored && stored.version === MODEL_VERSION ? stored : null);

module.exports = {
  safeNeed,
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
