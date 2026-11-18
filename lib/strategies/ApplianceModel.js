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

const SLOT_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_DELTA_W = 25;
const END_DELTA_W = 10;
const START_SAMPLES = 2;
const END_HOLD_MS = 30 * 60 * 1000;
const SHORT_HOLD_MS = 5 * 60 * 1000;
const PAUSE_HOLD_FACTOR = 1.5;
const FULL_SHARE = 0.9;
const MAX_RUN_MS = 8 * HOUR_MS;
const MIN_RUN_KWH = 0.05;
const RESTART_PAUSE_MS = 5 * 60 * 1000;
const RESTART_MS = 30 * 60 * 1000;
const RESTART_PEAK_SHARE = 0.5;
const OUTLIER_LENGTH = 1.75;
const OUTLIER_SHARE = 0.1;
const MAX_POWER_W = 10000;
const MAX_RUNS = 20;
const MIN_RUNS = 3;
const RATE_ALPHA = 0.2;
const MIN_DAYS = 2;

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
  baseW: null,
  runs: [],
  rate: new Array(7).fill(null).map(() => new Array(24).fill(0)),
  days: new Array(7).fill(0),
  starts: new Array(7).fill(0),
  day: null,
  dayStarts: [],
  planned: {},
  plannedDone: [],
  skipDay: null,
  pending: null,
  above: 0,
  run: null,
});

const closeRun = (run) => {
  const last = Math.floor((run.lastActive - run.start) / SLOT_MS);
  const kwh = run.slots.slice(0, last + 1).map((v) => Math.round((v || 0) * 10000) / 10000);
  const done = { start: run.start, end: run.lastActive, kwh };
  if (run.deadline) done.deadline = run.deadline;
  if ((run.coarseMin || 0) > (run.fineMin || 0)) done.coarse = true;
  else if (typeof run.maxPauseMs === 'number') done.pauseMin = Math.round(run.maxPauseMs / 60000);
  return done;
};

const totalKwh = (kwh) => kwh.reduce((a, v) => a + v, 0);

const isConfirmedRun = (run) => !!run && totalKwh(run.slots.map((v) => v || 0)) >= MIN_RUN_KWH;

const finishRun = (m, result, timezone, stuck = false) => {
  const done = closeRun(m.run);
  m.run = null;
  if (!stuck && totalKwh(done.kwh) >= MIN_RUN_KWH) {
    m.runs = [...m.runs, done].slice(-MAX_RUNS);
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

const processSample = (model, {
  t, powerW, meterKwh, timezone = 'UTC', coarse = false, deadlineFor = null, fullMin = null, endHoldMin = null,
  shortestMin = null, skipToday = false,
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
    run: model.run ? {
      ...model.run,
      slots: [...model.run.slots],
      resume: model.run.resume
        ? { ...model.run.resume, slots: [...model.run.resume.slots], resumeSlots: [...model.run.resume.resumeSlots] } : null,
    } : null,
  };
  const result = {
    model: m, event: null, run: null, restarted: false,
  };
  if (![t, powerW, meterKwh].every((v) => typeof v === 'number' && Number.isFinite(v))) return result;
  const p = Math.max(0, Math.min(MAX_POWER_W, powerW));

  if (m.run && t - m.run.lastTm >= END_HOLD_MS) finishRun(m, result, timezone);

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
      start: m.pending.t, lastActive: t, lastTm: m.pending.t, lastMeter: m.pending.meter, slots: [], coarseMin: 0, fineMin: 0, maxPauseMs: 0,
    };
    const deadline = typeof deadlineFor === 'function' ? deadlineFor(m.run.start) : null;
    if (deadline) m.run.deadline = deadline;
    m.pending = null;
    m.above = 0;
    result.event = 'started';
  }

  const { run } = m;
  const pauseMs = p > offW && !coarse ? Math.max(0, run.lastTm - run.lastActive) : 0;
  if (p > offW && !coarse && t - run.lastActive >= RESTART_PAUSE_MS) {
    run.resume = {
      t,
      lastActive: run.lastActive,
      peakW: run.peakW || 0,
      maxPauseMs: run.maxPauseMs,
      slots: [...run.slots],
      resumeSlots: [],
      resumePauseMs: 0,
      coarseMin: 0,
      fineMin: 0,
    };
  } else {
    if (run.resume && t - run.resume.t > RESTART_MS) run.resume = null;
    if (run.resume) run.resume.resumePauseMs = Math.max(run.resume.resumePauseMs, pauseMs);
  }
  if (typeof run.maxPauseMs === 'number') run.maxPauseMs = Math.max(run.maxPauseMs, pauseMs);

  if (coarse) run.coarseMin += 1;
  else run.fineMin += 1;
  const dE = meterKwh - run.lastMeter;
  const dH = (t - run.lastTm) / HOUR_MS;
  const add = (slots, from) => {
    const idx = Math.max(0, Math.floor((((run.lastTm + t) / 2) - from) / SLOT_MS));
    while (slots.length <= idx) slots.push(0);
    slots[idx] += dE;
  };
  if (dE >= 0 && dH >= 0 && dE <= (MAX_POWER_W / 1000) * Math.max(dH, 1 / 60)) {
    add(run.slots, run.start);
    if (run.resume) add(run.resume.resumeSlots, run.resume.t);
  }
  if (run.resume) {
    if (coarse) run.resume.coarseMin += 1;
    else run.resume.fineMin += 1;
  }
  run.lastTm = t;
  run.lastMeter = meterKwh;
  if (p > offW) run.lastActive = t;

  const { resume } = run;
  const beforeMs = resume ? resume.lastActive - run.start : 0;
  if (resume && resume.peakW > 0 && p >= RESTART_PEAK_SHARE * resume.peakW
    && !(shortestMin > 0 && beforeMs < FULL_SHARE * shortestMin * 60000)
    && totalKwh(resume.slots.slice(0, Math.floor(beforeMs / SLOT_MS) + 1)) >= MIN_RUN_KWH) {
    m.run = {
      ...run, lastActive: resume.lastActive, slots: resume.slots, maxPauseMs: resume.maxPauseMs, resume: null,
    };
    finishRun(m, result, timezone);
    m.run = {
      start: resume.t,
      lastActive: t,
      lastTm: t,
      lastMeter: meterKwh,
      slots: resume.resumeSlots,
      coarseMin: resume.coarseMin,
      fineMin: resume.fineMin,
      peakW: p,
      maxPauseMs: resume.resumePauseMs,
      resume: null,
    };
    const deadline = typeof deadlineFor === 'function' ? deadlineFor(resume.t) : null;
    if (deadline) m.run.deadline = deadline;
    result.restarted = true;
    return result;
  }
  run.peakW = Math.max(run.peakW || 0, p);

  const full = fullMin > 0 && run.lastActive - run.start >= FULL_SHARE * fullMin * 60000;
  const holdMs = endHoldMin > 0 ? endHoldMin * 60000 : END_HOLD_MS;
  const ended = t - run.lastActive >= (full ? SHORT_HOLD_MS : holdMs);
  if (ended || t - run.start >= MAX_RUN_MS) {
    finishRun(m, result, timezone, !ended);
  }
  return result;
};

const meanCurve = (runs) => {
  const lengths = runs.map((r) => r.kwh.length).sort((a, b) => a - b);
  const length = Math.max(1, lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))]);
  return Array.from({ length }, (_, i) => runs.reduce((sum, r) => sum + (r.kwh[i] || 0), 0) / runs.length);
};

const endHoldMin = (runs) => {
  const pauses = runs.filter((r) => typeof r.pauseMin === 'number').map((r) => r.pauseMin);
  if (pauses.length < MIN_RUNS) return null;
  const min = PAUSE_HOLD_FACTOR * Math.max(...pauses);
  return Math.round(Math.max(SHORT_HOLD_MS / 60000, Math.min(END_HOLD_MS / 60000, min)));
};

const getProfile = (model) => {
  const stored = (model && model.runs) || [];
  if (stored.length < MIN_RUNS) return null;
  const maxMs = OUTLIER_LENGTH * median(stored.map((r) => r.end - r.start));
  const kept = stored.filter((r) => r.end - r.start <= maxMs);
  const few = stored.length - kept.length <= Math.max(1, Math.floor(stored.length * OUTLIER_SHARE));
  const all = few && kept.length >= MIN_RUNS ? kept : stored;
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
    fullMin: Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))]),
    shortestMin: Math.round(durations[0]),
    peakW: Math.round(median(runs.map((r) => Math.max(...r.kwh) * 4000))),
    curveKwh,
    curveW: curveKwh.map((v) => Math.round(v * 4000)),
    endHoldMin: endHoldMin(all),
  };
};

const nearestCount = (n) => Math.max(3, Math.min(5, Math.round(n / 3)));

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

const rateFor = (model, dow, hour) => emaFor(model, model.rate.map((r) => r[hour]), dow);

const plannedFor = (model, key, dow) => emaFor(model, model.planned[key], dow);

const isReady = (model, profile) => !!(model && profile && model.days.some((n) => n >= MIN_DAYS));

const startsPerWeek = (model) => {
  let total = 0;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) total += rateFor(model, d, h);
    for (const key of Object.keys(model.planned || {})) total += plannedFor(model, key, d);
  }
  return total;
};

const runMs = (profile) => (profile ? profile.curveW.length * SLOT_MS : 0);

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

const expectedStarts = (model, profile, nowMs, endMs, timezone = 'UTC', plan = null, planByHand = true) => {
  if (!model || !profile) return [];
  let blockedUntil = 0;
  if (model.run) blockedUntil = Math.max(blockedUntil, model.run.start + runMs(profile));
  if (plan) blockedUntil = Math.max(blockedUntil, plan.startMs + runMs(profile));
  const quarterAt = startQuarters(model, timezone);
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

const cheapestSlotStart = (profile, { priceAt, fromMs, toMs }) => {
  if (!profile || typeof priceAt !== 'function') return null;
  let best = null;
  for (let start = Math.ceil(fromMs / SLOT_MS) * SLOT_MS; start < toMs; start += SLOT_MS) {
    const cost = runCost(profile, priceAt, start);
    if (cost !== null && (!best || cost < best.cost - 1e-9)) best = { startMs: start, cost };
  }
  return best;
};

const startWindow = (fromH, toH, nowMs, timezone = 'UTC') => {
  const midnight = (ms) => TimeHelpers.getLocalMidnightUTC(new Date(ms), timezone);
  const nextDay = (day) => midnight(day.getTime() + 26 * HOUR_MS);
  const at = (day, h) => (h >= 24 ? nextDay(day).getTime()
    : TimeHelpers.localTimeToUTC(day, TimeHelpers.formatClock(h), timezone).getTime());
  let day = midnight(midnight(nowMs).getTime() - 2 * HOUR_MS);
  for (let i = 0; i < 3; i += 1) {
    const fromMs = at(day, fromH);
    let toMs = at(day, toH);
    if (toMs <= fromMs) toMs = at(nextDay(day), toH);
    if (toMs > nowMs) return { fromMs: Math.max(fromMs, nowMs), toMs, windowFromMs: fromMs };
    day = nextDay(day);
  }
  return null;
};

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
    blockedUntil = Math.max(blockedUntil, start + length);
    if (start < endMs) out.push({ start, weight, deadline: at });
  });
  return out;
};

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

const nextExpectedStart = (model, profile, nowMs, timezone = 'UTC', priceAt = null, days = null, horizonMs = 7 * 24 * HOUR_MS) => {
  let sum = 0;
  const hit = expectedRuns(model, profile, nowMs, nowMs + horizonMs, timezone, null, priceAt, days).find((x) => {
    sum += x.weight;
    return sum >= 0.5;
  });
  return hit ? hit.start : null;
};

const COARSE_MIN_W = 150;

const learnHistory = (model, entries, { timezone = 'UTC', meterNowKwh = 0, planned = [] } = {}) => {
  const list = (entries || []).filter((e) => typeof e.v === 'number' && Number.isFinite(e.v))
    .map((e) => ({ t: typeof e.t === 'number' ? e.t : new Date(e.t).getTime(), v: Math.max(0, e.v) }))
    .sort((a, b) => a.t - b.t);
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

const mergeRuns = (runs, earlier) => {
  const kept = (earlier || []).filter((old) => !old.coarse
    && !runs.some((r) => Math.abs(r.start - old.start) < 30 * 60 * 1000));
  return [...runs, ...kept].sort((a, b) => a.start - b.start).slice(-MAX_RUNS);
};

const BOOTSTRAP_VERSION = 3;

module.exports = {
  BOOTSTRAP_VERSION,
  isConfirmedRun,
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
