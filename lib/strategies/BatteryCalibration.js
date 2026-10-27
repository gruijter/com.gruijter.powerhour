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

// Calibration of a battery's own SoC (its BMS): now and then fully empty, then fully full, each
// until the battery itself stops (gives or takes no more power while asked to). The planner gets
// the targets as SoC bounds (socBounds()); near empty (full) control asks full power until the
// battery stops (tail()). Pure: the device keeps the state in its store. Power in W, + charging.

const DAY_MS = 24 * 60 * 60 * 1000;

// From these SoCs control asks full power until the battery stops.
const EMPTY_SOC = 5;
const FULL_SOC = 95;
// In a calibration a stop counts from these SoCs: a battery with its own limits (in its app) stops
// before 0 % (100 %).
const PHASE_EMPTY_SOC = 20;
const PHASE_FULL_SOC = 80;
// Stopped: asked at least ASK_W, doing less than STOP_W, for STOP_MS (a battery can take a minute
// to start from standstill).
const ASK_W = 200;
const STOP_W = 50;
const STOP_MS = 5 * 60 * 1000;
// Asked on at 0 % (100 %) this long: done anyway, the battery's SoC was far off.
const TAIL_MAX_MS = 3 * 60 * 60 * 1000;
// A target this far past without the phase done: new targets.
const LATE_MS = 30 * 60 * 1000;
// chooseTargets(): waiting costs this share of the mean price per hour, so of alike windows the
// soonest wins.
const WAIT_SHARE = 0.01;
// The top-off at full: one plan slot more than the charge at full power takes.
const TOP_OFF_SLOTS = 1;

/**
 * @param {number} now
 * @returns {object} lastTm: the last calibration done (or the start: none at once after an update),
 *   phase: null | 'empty' | 'full', emptyByMs/fullByMs: the targets, emptyTm/fullTm: last stop seen
 */
const createState = (now) => ({
  lastTm: now, phase: null, requested: false, emptyByMs: null, fullByMs: null, emptyTm: null, fullTm: null,
});

// Due: asked by flow, or days (setting, 0 = off) since the last one.
const isDue = (state, days, now) => !!state && !state.phase
  && (!!state.requested || (days > 0 && now - (state.lastTm || 0) >= days * DAY_MS));

const start = (state, now, targets) => ({
  ...state, phase: 'empty', startTm: now, requested: false, stop: null, tailTm: null, ...targets,
});

// done: the full stop was reached; else stopped (flow): the next one after the interval too.
const end = (state, now) => ({
  ...state, phase: null, requested: false, lastTm: now, emptyByMs: null, fullByMs: null, stop: null, tailTm: null,
});

// The current phase's target has passed without the stop: new targets.
const isLate = (state, now) => {
  if (!state || !state.phase) return false;
  const target = state.phase === 'empty' ? state.emptyByMs : state.fullByMs;
  return !target || now > target + LATE_MS;
};

// 'empty' / 'full': control asks full power that way until the battery stops; null: the plan.
const tail = (state, socPct) => {
  if (!state || typeof socPct !== 'number') return null;
  if (state.phase === 'empty' && socPct <= EMPTY_SOC) return 'empty';
  if (state.phase === 'full' && socPct >= FULL_SOC) return 'full';
  return null;
};

/**
 * Every control tick: a stop at empty or full, also outside a calibration (a full after an empty
 * since the last calibration counts as one).
 *
 * @param {object} state
 * @param {object} o
 * @param {number} o.now
 * @param {number} o.socPct
 * @param {number|null} o.setW - the setpoint this app wrote last (null: not controlled)
 * @param {number} o.actW - measured power
 * @returns {{state: object, event: null|'empty'|'full', timeout: boolean, done: boolean, changed: boolean}}
 *   changed: worth storing (a phase, done, or a first empty since the last calibration)
 */
const onTick = (state, {
  now, socPct, setW, actW,
}) => {
  const none = {
    state, event: null, timeout: false, done: false, changed: false,
  };
  if (!state || typeof socPct !== 'number' || !Number.isFinite(actW)) return none;
  const asks = (dir) => typeof setW === 'number' && dir * setW >= ASK_W;
  const fullFrom = state.phase === 'full' ? PHASE_FULL_SOC : FULL_SOC;
  const emptyFrom = state.phase === 'empty' ? PHASE_EMPTY_SOC : EMPTY_SOC;
  let kind = null;
  if (socPct >= fullFrom && asks(1) && actW < STOP_W) kind = 'full';
  else if (socPct <= emptyFrom && asks(-1) && actW > -STOP_W) kind = 'empty';
  // fired: once per stop, not again until it ends.
  let stop = null;
  if (kind) stop = state.stop && state.stop.kind === kind ? state.stop : { kind, tm: now, fired: false };
  const atEnd = (state.phase === 'full' && socPct >= 100 && asks(1)) || (state.phase === 'empty' && socPct <= 0 && asks(-1));
  const tailTm = atEnd ? (state.tailTm || now) : null;
  let next = { ...state, stop, tailTm };
  let event = null;
  let timeout = false;
  if (stop && !stop.fired && now - stop.tm >= STOP_MS) {
    event = stop.kind;
    next.stop = { ...stop, fired: true };
  } else if (tailTm && now - tailTm >= TAIL_MAX_MS) {
    event = state.phase;
    timeout = true;
  }
  if (!event) {
    return {
      state: next, event: null, timeout: false, done: false, changed: false,
    };
  }
  let done = false;
  const firstEmpty = event === 'empty' && !(state.emptyTm > (state.lastTm || 0));
  if (event === 'empty') {
    next.emptyTm = now;
    if (next.phase === 'empty') next = { ...next, phase: 'full', tailTm: null };
  } else {
    next.fullTm = now;
    const natural = !next.phase && next.emptyTm && next.emptyTm > (next.lastTm || 0);
    if (next.phase === 'full' || natural) {
      next = end(next, now);
      done = true;
    }
  }
  return {
    state: next, event, timeout, done, changed: done || firstEmpty || next.phase !== state.phase,
  };
};

/**
 * When to be empty and then full: the window where the stored energy sells best before the empty
 * point and the full charge is cheapest after it, a little earlier preferred. Per plan slot from
 * the current one. null: the prices do not reach far enough.
 *
 * @param {object} o
 * @param {'empty'|'full'} o.phase - 'full': only the full point
 * @param {number} o.startMs - start of the first plan slot
 * @param {number} o.slotMin
 * @param {number[]} o.prices - import price per plan slot
 * @param {number[]} [o.exportPrices]
 * @param {Array<object>} [o.net] - per slot { usableSurplusW, usableDeficitW } (RoiStrategy)
 * @param {number} o.socPct
 * @param {number} o.capKwh
 * @param {number} o.maxChargeW
 * @param {number} o.maxDischargeW
 * @returns {{emptyByMs: number|null, fullByMs: number}|null}
 */
const chooseTargets = ({
  phase, startMs, slotMin, prices, exportPrices = null, net = null, socPct, capKwh, maxChargeW, maxDischargeW,
}) => {
  const T = Array.isArray(prices) ? prices.length : 0;
  if (!T || !(capKwh > 0) || !(maxChargeW > 0) || !(maxDischargeW > 0)) return null;
  const h = slotMin / 60;
  const slotMs = slotMin * 60 * 1000;
  const exportAt = (t) => (exportPrices && typeof exportPrices[t] === 'number' ? exportPrices[t] : prices[t]);
  // Surplus (deficit) for at least half the power: charged (discharged) at what the grid pays for it.
  const n = (t) => (Array.isArray(net) && net[t]) || {};
  const buy = (t) => ((Number(n(t).usableSurplusW) || 0) >= maxChargeW / 2 ? Math.min(prices[t], exportAt(t)) : prices[t]);
  const sell = (t) => ((Number(n(t).usableDeficitW) || 0) >= maxDischargeW / 2 ? Math.max(prices[t], exportAt(t)) : exportAt(t));
  const kEmpty = Math.max(1, Math.ceil(((Math.max(0, socPct) / 100) * capKwh) / ((maxDischargeW / 1000) * h)));
  const kFull = Math.ceil(capKwh / ((maxChargeW / 1000) * h)) + TOP_OFF_SLOTS;
  const meanPrice = prices.reduce((a, p) => a + Math.abs(p), 0) / T;
  const waitPerSlot = WAIT_SHARE * meanPrice * h;
  const insert = (sorted, v) => {
    let i = 0;
    while (i < sorted.length && sorted[i] < v) i += 1;
    sorted.splice(i, 0, v);
  };
  const lowMean = (sorted, k) => sorted.slice(0, k).reduce((a, v) => a + v, 0) / k;
  const highMean = (sorted, k) => sorted.slice(-k).reduce((a, v) => a + v, 0) / k;
  const toMs = (t) => startMs + ((t + 1) * slotMs);

  let best = null;
  if (phase === 'full') {
    const buys = [];
    for (let f = 0; f < T; f += 1) {
      insert(buys, buy(f));
      if (f + 1 >= kFull) {
        const score = -lowMean(buys, kFull) - (waitPerSlot * f);
        if (!best || score > best.score) best = { score, e: null, f };
      }
    }
    return best ? { emptyByMs: null, fullByMs: toMs(best.f) } : null;
  }
  const sells = [];
  for (let e = 0; e < T; e += 1) {
    insert(sells, sell(e));
    if (e + 1 >= kEmpty) {
      const value = highMean(sells, kEmpty);
      const buys = [];
      for (let f = e + 1; f < T; f += 1) {
        insert(buys, buy(f));
        if (f - e >= kFull) {
          const score = value - lowMean(buys, kFull) - (waitPerSlot * f);
          if (!best || score > best.score) best = { score, e, f };
        }
      }
    }
  }
  return best ? { emptyByMs: toMs(best.e), fullByMs: toMs(best.f) } : null;
};

// The planner's SoC bounds (%) per plan slot index from startMs: { [index]: { max } | { min } }, or
// null. A target outside the plan is left out.
const socBounds = (state, { startMs, slotMin, slots }) => {
  if (!state || !state.phase) return null;
  const slotMs = slotMin * 60 * 1000;
  const indexOf = (ms) => (typeof ms === 'number' ? Math.round((ms - startMs) / slotMs) - 1 : -1);
  const bounds = {};
  const e = state.phase === 'empty' ? indexOf(state.emptyByMs) : -1;
  const f = indexOf(state.fullByMs);
  if (e >= 0 && e < slots) bounds[e] = { max: 0 };
  if (f >= 0 && f < slots && f > e) bounds[f] = { min: 100 };
  return Object.keys(bounds).length ? bounds : null;
};

// How far (kWh) a stored energy is outside a bound.
const boundMissKwh = (bound, kwh, capKwh) => {
  if (!bound) return 0;
  const lo = typeof bound.min === 'number' ? (bound.min / 100) * capKwh : -Infinity;
  const hi = typeof bound.max === 'number' ? (bound.max / 100) * capKwh : Infinity;
  return Math.max(0, lo - kwh, kwh - hi);
};

module.exports = {
  ASK_W,
  EMPTY_SOC,
  FULL_SOC,
  STOP_MS,
  TAIL_MAX_MS,
  boundMissKwh,
  chooseTargets,
  createState,
  end,
  isDue,
  isLate,
  onTick,
  socBounds,
  start,
  tail,
};
