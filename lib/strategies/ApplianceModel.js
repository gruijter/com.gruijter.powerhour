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

// An appliance with programs (washing machine, dishwasher, dryer), measured by a power
// summarizer. Learned from a sample per minute (power and meter):
//  - runs: start when the power stays above the standby level, end after END_HOLD_MS without
//    activity. Per run the energy per 15 minutes since its start.
//  - the program curve: per 15 minutes since the start the median over the last runs.
//  - the start rate: expected starts per weekday and local hour, of the runs started by hand.
//  - planned runs (started by Homey at the best start, tagged with their "ready by" time): per
//    ready-by time ('HH:MM') the expected runs per weekday.
// The forecast is the standby power, the rest of the curve of a running program, for the coming
// hours start rate x curve, and the planned runs at the cheapest start before their ready-by time. The grid device learns the home load without these appliances
// and adds this forecast.

const SLOT_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_DELTA_W = 25; // above standby: active
const END_DELTA_W = 10; // at most this above standby: inactive
const START_SAMPLES = 2; // consecutive active samples for a start
const END_HOLD_MS = 30 * 60 * 1000; // inactive this long: the run has ended (pauses, drying)
const SHORT_HOLD_MS = 5 * 60 * 1000; // the same, once the run reached its learned length
const FULL_SHARE = 0.9; // share of the learned length (fullMin) that counts as reached
const MAX_RUN_MS = 8 * HOUR_MS; // longer is no program (a stuck or stale reading): discarded
const MIN_RUN_KWH = 0.05; // less is no program (a pump-out, a display)
const MAX_POWER_W = 10000; // a sample or meter step above this is not plausible
const MAX_RUNS = 20;
const MIN_RUNS = 3; // runs before the curve is used
const RATE_ALPHA = 0.2; // ~5 weeks memory per weekday
const MIN_DAYS = 2; // observed days of a weekday before its own rate is used

const localDay = (ms, timezone) => {
  const local = TimeHelpers.toLocalDate(new Date(ms), timezone);
  return {
    date: `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`,
    dow: local.getDay(),
    hour: local.getHours(),
    hhmm: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
  };
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const initModel = () => ({
  baseW: null, // standby power
  runs: [], // { start, end, kwh: [per 15 minutes] }
  rate: new Array(7).fill(null).map(() => new Array(24).fill(0)), // EMA of starts per weekday-hour
  days: new Array(7).fill(0), // observed days per weekday
  starts: new Array(7).fill(0), // runs per weekday on those days
  day: null, // local date of dayStarts
  dayStarts: [], // local start hours of the runs today
  planned: {}, // per deadline 'HH:MM' (latest start): EMA of planned runs per weekday (of the deadline day)
  plannedDone: [], // { date, key }: planned runs of days not counted yet
  skipDay: null, // local date set by hand (day picker): not learned as a normal day
  pending: null, // { t, meter }: first active sample of a possible start
  above: 0,
  run: null, // { start, lastActive, lastTm, lastMeter, slots, coarseMin, fineMin }
});

// The run as stored: energy per slot up to the last activity, in kWh.
const closeRun = (run) => {
  const last = Math.floor((run.lastActive - run.start) / SLOT_MS);
  const kwh = run.slots.slice(0, last + 1).map((v) => Math.round((v || 0) * 10000) / 10000);
  const done = { start: run.start, end: run.lastActive, kwh };
  if (run.deadline) done.deadline = run.deadline;
  // Mostly from hourly history: start and curve are rough.
  if ((run.coarseMin || 0) > (run.fineMin || 0)) done.coarse = true;
  return done;
};

const totalKwh = (kwh) => kwh.reduce((a, v) => a + v, 0);

// End the running program at its last activity: stored when it is a program, the start counted
// for its day. Not for a stuck run (still active at MAX_RUN_MS).
const finishRun = (m, result, timezone, stuck = false) => {
  const done = closeRun(m.run);
  m.run = null;
  if (!stuck && totalKwh(done.kwh) >= MIN_RUN_KWH) {
    m.runs = [...m.runs, done].slice(-MAX_RUNS);
    // A day already rolled over (a run past midnight): its EMA step gets the start afterwards,
    // RATE_ALPHA x one more start.
    if (done.deadline) {
      const due = localDay(done.deadline, timezone);
      if (!m.day || due.date >= m.day) m.plannedDone.push({ date: due.date, key: due.hhmm });
      else {
        if (!m.planned[due.hhmm]) m.planned[due.hhmm] = new Array(7).fill(0);
        m.planned[due.hhmm][due.dow] += RATE_ALPHA;
        if (m.skipDay !== due.date) m.starts[due.dow] += 1;
      }
    } else {
      const startDay = localDay(done.start, timezone);
      if (startDay.date === m.day) m.dayStarts.push(startDay.hour);
      else if (startDay.date < m.day && m.skipDay !== startDay.date) {
        m.rate[startDay.dow][startDay.hour] += RATE_ALPHA;
        m.starts[startDay.dow] += 1;
      }
    }
    result.event = 'finished';
    result.run = done;
  } else if (result.event === 'started') {
    result.event = null;
  }
};

/**
 * One sample. Returns the new model and an event: 'started', 'finished' (with the stored run)
 * or null.
 * @param {object} model - from initModel(), not changed
 * @param {object} s - { t (ms), powerW, meterKwh, timezone, deadlineFor(startMs) -> the deadline
 *   (ms) of a run Homey started at its planned start, else null, fullMin - the learned
 *   length (profile.fullMin) or null, skipToday - today is set by hand: not learned }
 */
const processSample = (model, {
  t, powerW, meterKwh, timezone = 'UTC', coarse = false, deadlineFor = null, fullMin = null, skipToday = false,
}) => {
  const m = {
    ...model,
    rate: model.rate.map((r) => [...r]),
    days: [...model.days],
    starts: model.starts ? [...model.starts] : new Array(7).fill(0),
    dayStarts: [...model.dayStarts],
    planned: Object.fromEntries(Object.entries(model.planned || {}).map(([k, r]) => [k, [...r]])),
    plannedDone: [...(model.plannedDone || [])],
    runs: model.runs,
    run: model.run ? { ...model.run, slots: [...model.run.slots] } : null,
  };
  const result = { model: m, event: null, run: null };
  if (![t, powerW, meterKwh].every((v) => typeof v === 'number' && Number.isFinite(v))) return result;
  const p = Math.max(0, Math.min(MAX_POWER_W, powerW));

  // No samples for longer than the end time (Homey or the device offline, a gap in history):
  // the running program ended at its last activity, before this sample and a new day.
  if (m.run && t - m.run.lastTm >= END_HOLD_MS) finishRun(m, result, timezone);

  // A new local day: the starts of the past day into the rate of its weekday.
  const today = localDay(t, timezone);
  if (m.day !== today.date) {
    if (m.day) {
      const [y, mo, d] = m.day.split('-').map(Number);
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const normal = m.skipDay !== m.day;
      const counts = new Array(24).fill(0);
      m.dayStarts.forEach((h) => {
        counts[h] += 1;
      });
      if (normal) m.rate[dow] = m.rate[dow].map((r, h) => (r * (1 - RATE_ALPHA)) + (RATE_ALPHA * counts[h]));
      // Planned runs per ready-by time. A new time starts at 0: the days before had no such run.
      const past = m.plannedDone.filter((x) => x.date <= m.day);
      past.forEach(({ key }) => {
        if (!m.planned[key]) m.planned[key] = new Array(7).fill(0);
      });
      Object.keys(m.planned).forEach((key) => {
        const n = past.filter((x) => x.key === key && x.date === m.day).length;
        m.planned[key][dow] = (m.planned[key][dow] * (1 - RATE_ALPHA)) + (RATE_ALPHA * n);
      });
      m.plannedDone = m.plannedDone.filter((x) => x.date > m.day);
      if (normal) {
        m.days[dow] += 1;
        m.starts[dow] += m.dayStarts.length + past.filter((x) => x.date === m.day).length;
      }
    }
    m.day = today.date;
    m.dayStarts = [];
  }
  if (skipToday) m.skipDay = m.day;

  if (m.baseW === null) m.baseW = p;
  const onW = m.baseW + START_DELTA_W;
  const offW = m.baseW + END_DELTA_W;

  if (!m.run) {
    // Standby: follows low values fast, higher idle values slowly.
    if (p < m.baseW) m.baseW = (0.8 * m.baseW) + (0.2 * p);
    else if (p < onW) m.baseW = (0.98 * m.baseW) + (0.02 * p);
    if (p <= onW) {
      m.above = 0;
      m.pending = null;
      return result;
    }
    m.above += 1;
    if (!m.pending) m.pending = { t, meter: meterKwh };
    if (m.above < START_SAMPLES) return result;
    m.run = {
      start: m.pending.t, lastActive: t, lastTm: m.pending.t, lastMeter: m.pending.meter, slots: [], coarseMin: 0, fineMin: 0,
    };
    const deadline = typeof deadlineFor === 'function' ? deadlineFor(m.run.start) : null;
    if (deadline) m.run.deadline = deadline;
    m.pending = null;
    m.above = 0;
    result.event = 'started';
  }

  // Energy since the previous sample, in the slot of its midpoint.
  const { run } = m;
  if (coarse) run.coarseMin += 1;
  else run.fineMin += 1;
  const dE = meterKwh - run.lastMeter;
  const dH = (t - run.lastTm) / HOUR_MS;
  if (dE >= 0 && dH >= 0 && dE <= (MAX_POWER_W / 1000) * Math.max(dH, 1 / 60)) {
    const idx = Math.floor((((run.lastTm + t) / 2) - run.start) / SLOT_MS);
    while (run.slots.length <= idx) run.slots.push(0);
    run.slots[idx] += dE;
  }
  run.lastTm = t;
  run.lastMeter = meterKwh;
  if (p > offW) run.lastActive = t;

  const full = fullMin > 0 && run.lastActive - run.start >= FULL_SHARE * fullMin * 60000;
  const ended = t - run.lastActive >= (full ? SHORT_HOLD_MS : END_HOLD_MS);
  if (ended || t - run.start >= MAX_RUN_MS) {
    finishRun(m, result, timezone, !ended);
  }
  return result;
};

// Per 15 minutes since the start the mean energy (kWh) of the runs, 0 after a run ended: the
// expected value, which a forecast for planning needs (a median per slot underestimates when
// programs differ, e.g. 2 of 5 washes hot). Up to the length of 90% of the runs.
const meanCurve = (runs) => {
  const lengths = runs.map((r) => r.kwh.length).sort((a, b) => a - b);
  const length = Math.max(1, lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))]);
  return Array.from({ length }, (_, i) => runs.reduce((sum, r) => sum + (r.kwh[i] || 0), 0) / runs.length);
};

/**
 * The program: the mean curve per 15 minutes since the start (kWh and W), its energy, the
 * median duration and peak, and the runs it is made of (basis). Null before MIN_RUNS runs.
 * The curve comes from runs measured per minute (or 5 minutes) only: hourly history flattens a
 * program (15 minutes heating at 2 kW is an hour at 600 W). Without such a run the hourly
 * runs are used for the forecast, marked coarse.
 */
const getProfile = (model) => {
  const all = (model && model.runs) || [];
  if (all.length < MIN_RUNS) return null;
  const fine = all.filter((r) => !r.coarse);
  const runs = fine.length ? fine : all;
  const curveKwh = meanCurve(runs);
  const durations = runs.map((r) => (r.end - r.start) / 60000).sort((a, b) => a - b);
  return {
    coarse: !fine.length,
    runs: all.length,
    basis: runs,
    kwh: Math.round(totalKwh(curveKwh) * 1000) / 1000,
    durationMin: Math.round(median(durations)),
    // Length of 90% of the runs, like the curve: after it, a pause is the end.
    fullMin: Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))]),
    peakW: Math.round(median(runs.map((r) => Math.max(...r.kwh) * 4000))),
    curveKwh,
    curveW: curveKwh.map((v) => Math.round(v * 4000)),
  };
};

// Runs to compare a running program with: a third of the runs, 3 to 5, so that a program run
// less often (2 of 5 washes hot) is not mixed with the others.
const nearestCount = (n) => Math.max(3, Math.min(5, Math.round(n / 3)));

/**
 * The curve (W per 15 minutes since its start) of the running program: once a quarter is
 * measured, the mean of the earlier runs that started most like it (a hot wash, a wet load);
 * else the program curve. Null without a profile.
 */
const runningCurveW = (model, profile, nowMs) => {
  if (!profile) return null;
  const { run } = model || {};
  const measuredSlots = run ? Math.floor((nowMs - run.start) / SLOT_MS) : 0;
  const k = nearestCount(profile.basis.length);
  if (measuredSlots < 1 || profile.basis.length <= k) return profile.curveW;
  const measured = run.slots.slice(0, measuredSlots).map((v) => v || 0);
  const distance = (r) => measured.reduce((sum, v, i) => sum + ((v - (r.kwh[i] || 0)) ** 2), 0);
  const nearest = [...profile.basis].sort((a, b) => distance(a) - distance(b)).slice(0, k);
  return meanCurve(nearest).map((v) => Math.round(v * 4000));
};

// Expected count on a weekday from an EMA per weekday (rates[dow]). The EMA is corrected for its
// start at 0; a weekday seen fewer than MIN_DAYS times uses the mean of the weekdays that were seen.
const emaFor = (model, rates, dow) => {
  const corrected = (d) => {
    const weight = 1 - ((1 - RATE_ALPHA) ** model.days[d]);
    return weight > 0 ? rates[d] / weight : 0;
  };
  if (model.days[dow] >= MIN_DAYS) return corrected(dow);
  const seen = model.days.map((n, d) => (n >= MIN_DAYS ? d : -1)).filter((d) => d >= 0);
  if (!seen.length) return 0;
  return seen.reduce((sum, d) => sum + corrected(d), 0) / seen.length;
};

// Expected starts by hand in a weekday-hour.
const rateFor = (model, dow, hour) => emaFor(model, model.rate.map((r) => r[hour]), dow);

// Expected planned runs ready by 'HH:MM' on a weekday.
const plannedFor = (model, key, dow) => emaFor(model, model.planned[key], dow);

// Learned enough to forecast: a program curve and a weekday seen MIN_DAYS times. Before that the
// appliance stays in the learned home load.
const isReady = (model, profile) => !!(model && profile && model.days.some((n) => n >= MIN_DAYS));

// Expected starts per week, for the status text.
const startsPerWeek = (model) => {
  let total = 0;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) total += rateFor(model, d, h);
    for (const key of Object.keys(model.planned || {})) total += plannedFor(model, key, d);
  }
  return total;
};

// The program run time (ms) of the learned curve.
const runMs = (profile) => (profile ? profile.curveW.length * SLOT_MS : 0);

// Usual start minute (0, 15, 30 or 45) per weekday-hour: the median of the runs started by hand
// in that weekday-hour, else in that hour on any day, else 30.
const startQuarters = (model, timezone) => {
  const runs = (model.runs || []).filter((r) => !r.coarse && !r.deadline).map((r) => {
    const local = TimeHelpers.toLocalDate(new Date(r.start), timezone);
    return { dow: local.getDay(), hour: local.getHours(), min: local.getMinutes() };
  });
  return (dow, hour) => {
    let mins = runs.filter((r) => r.dow === dow && r.hour === hour).map((r) => r.min);
    if (!mins.length) mins = runs.filter((r) => r.hour === hour).map((r) => r.min);
    return mins.length ? Math.min(45, Math.round(median(mins) / 15) * 15) : 30;
  };
};

/**
 * Expected starts by hand from now to endMs: per hour a start at its usual quarter, weighted by
 * the start rate; an hour whose usual quarter has passed has none. Today's starts are lowered by those that already happened today. No start
 * while a program runs or before a planned run has ended.
 * @param {object|null} plan - { startMs } of a planned run
 * @param {boolean} planByHand - the plan replaces a start by hand (its deadline is not learned)
 * @returns {Array<{start, weight}>}
 */
const expectedStarts = (model, profile, nowMs, endMs, timezone = 'UTC', plan = null, planByHand = true) => {
  if (!model || !profile) return [];
  let blockedUntil = 0;
  if (model.run) blockedUntil = Math.max(blockedUntil, model.run.start + runMs(profile));
  if (plan) blockedUntil = Math.max(blockedUntil, plan.startMs + runMs(profile));
  const quarterAt = startQuarters(model, timezone);
  // Per local day the expected starts are lowered by the starts that day already has: today's
  // runs, a running program, and a planned run on its day.
  const today = localDay(nowMs, timezone).date;
  const started = { [today]: (model.day === today ? model.dayStarts.length : 0) + (model.run && !model.run.deadline ? 1 : 0) };
  if (plan && planByHand) {
    const planDay = localDay(plan.startMs, timezone).date;
    started[planDay] = (started[planDay] || 0) + 1;
  }
  const hours = [];
  for (let h = TimeHelpers.startOfLocalBlock(nowMs, 60, timezone); h < endMs; h += HOUR_MS) {
    const local = localDay(h, timezone);
    const start = h + quarterAt(local.dow, local.hour) * 60000;
    if (start + SLOT_MS <= nowMs) continue; // eslint-disable-line no-continue
    const rate = start < blockedUntil ? 0 : rateFor(model, local.dow, local.hour);
    hours.push({ start, rate, ...local });
  }
  const factors = {};
  [...new Set(hours.map((x) => x.date))].forEach((date) => {
    const dayHours = hours.filter((x) => x.date === date);
    const { dow } = dayHours[0];
    let expected = 0;
    for (let h = 0; h < 24; h += 1) expected += rateFor(model, dow, h);
    const remaining = dayHours.reduce((sum, x) => sum + x.rate, 0);
    factors[date] = remaining > 0 ? Math.max(0, Math.min(1, (expected - (started[date] || 0)) / remaining)) : 0;
  });
  return hours
    .map(({ start, rate, date }) => ({ start, weight: rate * factors[date] }))
    .filter((x) => x.weight > 0);
};

/**
 * Cheapest start of the program from now to latestStartMs (so that it ends in time).
 * @param {object} profile - from getProfile()
 * @param {object} o - { priceAt(ms) -> price or null, nowMs, latestStartMs }
 * @returns {{startMs, cost, costNow}|null} null without prices for any start; costNow null
 *   without prices for a start now
 */
// Cost of a run that starts at start; null when a price is missing.
const runCost = (profile, priceAt, start) => {
  let cost = 0;
  for (let i = 0; i < profile.curveKwh.length; i += 1) {
    const price = priceAt(start + ((i + 0.5) * SLOT_MS));
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    cost += profile.curveKwh[i] * price;
  }
  return cost;
};

const bestStart = (profile, { priceAt, nowMs, latestStartMs }) => {
  if (!profile || typeof priceAt !== 'function') return null;
  const costAt = (start) => runCost(profile, priceAt, start);
  const costNow = costAt(nowMs);
  let best = costNow === null ? null : { startMs: nowMs, cost: costNow };
  for (let start = (Math.floor(nowMs / SLOT_MS) + 1) * SLOT_MS; start <= latestStartMs; start += SLOT_MS) {
    const cost = costAt(start);
    if (cost !== null && (!best || cost < best.cost - 1e-9)) best = { startMs: start, cost };
  }
  return best ? { ...best, costNow } : null;
};

/**
 * Cheapest 15-minute slot start from fromMs to toMs (excl.), earliest on a tie. Starts without
 * prices for the whole run are left out (like the DAP "next known hours" cards).
 * @returns {{startMs, cost}|null}
 */
const cheapestSlotStart = (profile, { priceAt, fromMs, toMs }) => {
  if (!profile || typeof priceAt !== 'function') return null;
  let best = null;
  for (let start = Math.ceil(fromMs / SLOT_MS) * SLOT_MS; start < toMs; start += SLOT_MS) {
    const cost = runCost(profile, priceAt, start);
    if (cost !== null && (!best || cost < best.cost - 1e-9)) best = { startMs: start, cost };
  }
  return best;
};

// The start window "between fromH and toH" (local decimal hours; toH 24 = midnight; toH not
// after fromH: over midnight): the one now is in, from now, else the next. { fromMs, toMs } or null.
const startWindow = (fromH, toH, nowMs, timezone = 'UTC') => {
  const midnight = (ms) => TimeHelpers.getLocalMidnightUTC(new Date(ms), timezone);
  const nextDay = (day) => midnight(day.getTime() + 26 * HOUR_MS);
  const at = (day, h) => (h >= 24 ? nextDay(day).getTime()
    : TimeHelpers.localTimeToUTC(day, TimeHelpers.formatClock(h), timezone).getTime());
  let day = midnight(midnight(nowMs).getTime() - 2 * HOUR_MS); // yesterday: a window over midnight
  for (let i = 0; i < 3; i += 1) {
    const fromMs = at(day, fromH);
    let toMs = at(day, toH);
    if (toMs <= fromMs) toMs = at(nextDay(day), toH);
    if (toMs > nowMs) return { fromMs: Math.max(fromMs, nowMs), toMs };
    day = nextDay(day);
  }
  return null;
};

// The local times 'HH:MM' of each day as ms from fromMs to toMs, in order.
const dailyTimes = (keys, fromMs, toMs, timezone = 'UTC') => {
  const times = [];
  let day = TimeHelpers.getLocalMidnightUTC(new Date(fromMs), timezone);
  while (day.getTime() <= toMs) {
    for (const key of keys) {
      const at = TimeHelpers.localTimeToUTC(day, key, timezone).getTime();
      if (at > fromMs && at <= toMs) times.push({ key, at });
    }
    day = TimeHelpers.getLocalMidnightUTC(new Date(day.getTime() + 26 * HOUR_MS), timezone);
  }
  return times.sort((a, b) => a.at - b.at);
};

const sameTime = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 60 * 1000;

/**
 * Expected planned runs that start before endMs: per learned deadline the expected runs (at most
 * 1) at the cheapest start after the deadline before it; without prices at the deadline. Not for
 * a deadline that has its run (done, running or planned).
 * @returns {Array<{start, weight, deadline}>}
 */
const plannedRuns = (model, profile, nowMs, endMs, timezone = 'UTC', plan = null, priceAt = null) => {
  const keys = Object.keys((model && model.planned) || {});
  if (!profile || !keys.length) return [];
  const length = runMs(profile);
  let blockedUntil = nowMs;
  if (model.run) blockedUntil = Math.max(blockedUntil, model.run.start + length);
  const times = dailyTimes(keys, nowMs - 24 * HOUR_MS, endMs + 24 * HOUR_MS, timezone);
  const out = [];
  times.forEach(({ key, at }, i) => {
    if (at <= nowMs || i === 0) return;
    if (plan && sameTime(plan.deadline, at)) {
      blockedUntil = Math.max(blockedUntil, plan.startMs + length);
      return;
    }
    const has = (model.run && sameTime(model.run.deadline, at)) || model.runs.some((r) => sameTime(r.deadline, at));
    if (has) return;
    const weight = Math.min(1, plannedFor(model, key, localDay(at, timezone).dow));
    const from = Math.max(blockedUntil, times[i - 1].at);
    if (weight < 0.01 || at < from) return;
    const best = bestStart(profile, { priceAt, nowMs: from, latestStartMs: at });
    const start = best ? best.startMs : at;
    blockedUntil = Math.max(blockedUntil, start + length); // no overlap with the next one
    if (start < endMs) out.push({ start, weight, deadline: at });
  });
  return out;
};

/**
 * All expected runs, by hand and planned: [{ start, weight }] by start. A day set by hand (days)
 * has only its own start, if any.
 * @param {object|null} days - { dates: [local dates set by hand], starts: [ms not started yet] }
 */
const expectedRuns = (model, profile, nowMs, endMs, timezone = 'UTC', plan = null, priceAt = null, days = null) => {
  const planned = plannedRuns(model, profile, nowMs, endMs, timezone, plan, priceAt);
  const planByHand = !!plan && !Object.keys(model.planned || {}).includes(localDay(plan.deadline, timezone).hhmm);
  const setDates = new Set((days && days.dates) || []);
  return [
    ...expectedStarts(model, profile, nowMs, endMs, timezone, plan, planByHand),
    ...planned,
  ].filter((x) => !setDates.has(localDay(x.start, timezone).date))
    .concat(((days && days.starts) || []).filter((start) => start < endMs).map((start) => ({ start, weight: 1 })))
    .sort((a, b) => a.start - b.start);
};

/**
 * Expected power (W) per 15-minute slot from startMs (slot aligned) to endMs: standby, the rest
 * of a running program, a planned run, and the expected runs.
 * @param {object|null} plan - { startMs, deadline }
 * @param {function|null} priceAt - ms -> price, for the start of the expected planned runs
 * @param {object|null} days - days set by hand, see expectedRuns()
 */
const getForecastSeries = (model, profile, startMs, endMs, nowMs, timezone = 'UTC', plan = null, priceAt = null, days = null) => {
  const count = Math.max(0, Math.ceil((endMs - startMs) / SLOT_MS));
  const out = new Array(count).fill(Math.round((model && model.baseW) || 0));
  if (!model || !profile) return out;
  const add = (runStart, weight, fromIndex = 0, curve = profile.curveW) => {
    for (let i = Math.max(0, fromIndex); i < curve.length; i += 1) {
      const idx = Math.floor((runStart + (i * SLOT_MS) - startMs) / SLOT_MS);
      if (idx >= 0 && idx < count) out[idx] += weight * curve[i];
    }
  };
  if (model.run) {
    add(model.run.start, 1, Math.floor((nowMs - model.run.start) / SLOT_MS), runningCurveW(model, profile, nowMs));
  } else if (plan) {
    add(plan.startMs, 1, Math.floor((nowMs - plan.startMs) / SLOT_MS));
  }
  expectedRuns(model, profile, nowMs, endMs, timezone, model.run ? null : plan, priceAt, days)
    .forEach(({ start, weight }) => add(start, weight));
  return out.map((v) => Math.round(v));
};

// The most likely next start within horizonMs (a week: an appliance may skip days): where the
// expected starts add up to one half.
const nextExpectedStart = (model, profile, nowMs, timezone = 'UTC', priceAt = null, days = null, horizonMs = 7 * 24 * HOUR_MS) => {
  let sum = 0;
  const hit = expectedRuns(model, profile, nowMs, nowMs + horizonMs, timezone, null, priceAt, days).find((x) => {
    sum += x.weight;
    return sum >= 0.5;
  });
  return hit ? hit.start : null;
};

// In hourly history an hour below this average is no program (a pump, a pause, standby), so
// that two programs with a pause between them are not one run: a program uses more in its hours.
const COARSE_MIN_W = 150;

/**
 * Learn from history (Insights): power entries { t, v (W) }, each the average until the next.
 * Replayed as a sample per minute, with a meter that ends at meterNowKwh. Runs near the start of
 * a planned run of planned ([{ start, deadline }], the runs measured live) are planned runs. Entries more than 10
 * minutes apart (hourly history) make coarse runs, an hour below COARSE_MIN_W counts as idle;
 * gaps over 2 hours are skipped.
 */
const learnHistory = (model, entries, { timezone = 'UTC', meterNowKwh = 0, planned = [] } = {}) => {
  const list = (entries || []).filter((e) => typeof e.v === 'number' && Number.isFinite(e.v))
    .map((e) => ({ t: typeof e.t === 'number' ? e.t : new Date(e.t).getTime(), v: Math.max(0, e.v) }))
    .sort((a, b) => a.t - b.t);
  // A value repeated 3 times or more (not 0) is stale: the device stopped reporting.
  const stale = list.map((e, i) => e.v > 0 && (
    (list[i - 1] && list[i + 1] && list[i - 1].v === e.v && list[i + 1].v === e.v)
    || (list[i + 1] && list[i + 2] && list[i + 1].v === e.v && list[i + 2].v === e.v)
    || (list[i - 1] && list[i - 2] && list[i - 1].v === e.v && list[i - 2].v === e.v)));
  const steps = [];
  let total = 0;
  for (let i = 0; i < list.length - 1; i += 1) {
    const gap = list[i + 1].t - list[i].t;
    if (gap > 0 && gap <= 2 * HOUR_MS && !stale[i]) {
      const v = gap > 10 * 60 * 1000 && list[i].v < COARSE_MIN_W ? 0 : list[i].v;
      steps.push({ t: list[i].t, v, gap });
      total += (v * gap) / 3600000000;
    }
  }
  // Runs measured live as planned stay planned (Insights has no plan).
  const deadlineFor = (start) => {
    const run = planned.find((r) => r.deadline && Math.abs(r.start - start) < 30 * 60 * 1000);
    return run ? run.deadline : null;
  };
  let m = model;
  let meter = meterNowKwh - total;
  steps.forEach(({ t, v, gap }) => {
    const coarse = gap > 10 * 60 * 1000;
    for (let at = t; at < t + gap; at += 60 * 1000) {
      const dt = Math.min(60 * 1000, t + gap - at);
      meter += (v * dt) / 3600000000;
      m = processSample(m, {
        t: at, powerW: v, meterKwh: meter, timezone, coarse, deadlineFor,
      }).model;
    }
  });
  return m;
};

/**
 * Per weekday (0 = Sunday): expected runs, whether learned (seen MIN_DAYS times), runs and
 * observed days, and the median local start time of its runs ('HH:MM' or null).
 */
const getWeekly = (model, timezone = 'UTC') => Array.from({ length: 7 }, (_, dow) => {
  let expected = 0;
  for (let h = 0; h < 24; h += 1) expected += rateFor(model, dow, h);
  Object.keys(model.planned || {}).forEach((key) => {
    expected += plannedFor(model, key, dow);
  });
  const minutes = (model.runs || []).map((r) => TimeHelpers.toLocalDate(new Date(r.start), timezone))
    .filter((d) => d.getDay() === dow)
    .map((d) => d.getHours() * 60 + d.getMinutes());
  const med = minutes.length ? Math.round(median(minutes)) : null;
  return {
    expected,
    learned: model.days[dow] >= MIN_DAYS,
    starts: (model.starts || [])[dow] || 0,
    days: model.days[dow],
    start: med === null ? null : `${String(Math.floor(med / 60)).padStart(2, '0')}:${String(med % 60).padStart(2, '0')}`,
  };
});

// Runs from a new learnHistory() with the earlier runs measured live that it does not have
// (older than the history, or a start not within 30 minutes of one of its runs).
const mergeRuns = (runs, earlier) => {
  const kept = (earlier || []).filter((old) => !old.coarse
    && !runs.some((r) => Math.abs(r.start - old.start) < 30 * 60 * 1000));
  return [...runs, ...kept].sort((a, b) => a.start - b.start).slice(-MAX_RUNS);
};

// Version of learnHistory(): a model bootstrapped by an older one learns its history again.
const BOOTSTRAP_VERSION = 3;

module.exports = {
  BOOTSTRAP_VERSION,
  learnHistory,
  mergeRuns,
  getWeekly,
  SLOT_MS,
  MIN_RUNS,
  initModel,
  processSample,
  getProfile,
  runningCurveW,
  getForecastSeries,
  nextExpectedStart,
  dailyTimes,
  localDay,
  runMs,
  isReady,
  startsPerWeek,
  bestStart,
  runCost,
  cheapestSlotStart,
  startWindow,
};
