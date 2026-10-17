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

// Real-time control of a home battery from its mode and plan (RoiStrategy blocks). Pure: the
// device writes the power. Power in W, + charging / - discharging (Homey's target_power).

const MODES = ['smart', 'self_consumption', 'xom', 'hold', 'idle', 'charge', 'discharge', 'device'];

// Modes the planner (RoiStrategy) restricts. Self-consumption: least import and export first, then
// the cheapest way. XOM (zero on the meter, whatever the plan) is planned as self-consumption, its
// nearest forecast.
const planOptionsFor = (mode) => {
  if (mode === 'self_consumption' || mode === 'xom') return { allowGridCharge: false, allowExport: false, minimizeGrid: true };
  // Idle: no plan (BatFlows.solve()), the reserve not refilled either.
  if (mode === 'idle') return { allowGridCharge: false, allowExport: false, idle: true };
  return {};
};

// Zero on the meter below a minimum power: start on the averaged need, stop when it stays under
// STOP_FACTOR x the minimum for STOP_AFTER_MS.
const STOP_FACTOR = 0.8;
const STOP_AFTER_MS = 2 * 60 * 1000;
const AVG_TAU_MS = 60 * 1000;

// Zero on the meter integrates: new power = last power - grid x GAIN. The grid reading lags the
// setpoint by a tick or so; a gain of 1 would overshoot and oscillate, 0.5 settles in a few ticks.
const GAIN = 0.5;

// Write a new power only on this change (zero on the meter: finer), or again after KEEPALIVE_MS.
const WRITE_STEP_W = 50;
const WRITE_STEP_ZERO_W = 20;
const KEEPALIVE_MS = 60 * 1000;

// A battery that does not do its setpoint (its own limits, e.g. near empty): judged FOLLOW_SETTLE_MS
// after a write, lagging more than FOLLOW_TOL_W (or 10 %) for FOLLOW_LAG_MS (a Sessy takes up to a
// minute to start from standstill).
const FOLLOW_SETTLE_MS = 10 * 1000;
const FOLLOW_LAG_MS = 75 * 1000;
const FOLLOW_TOL_W = 150;
const FOLLOW_STEP_W = 100;

// Zero on the meter integrates on what control decided, at most this far ahead of what the battery
// does (anti-windup while it starts or lags): a share of its max power, at least LEAD_MIN_W. Only
// for a battery that reports its power at least every FAST_REPORT_MS while running (a stale value
// would hold the integrator back).
const LEAD_SHARE = 0.3;
const LEAD_MIN_W = 300;
const FAST_REPORT_MS = 15 * 1000;

// Zero on the meter over a group, per battery and tick: more need (above RISE_MIN_W) only once it
// lasted RISE_HOLD_MS, so short spikes (a Quooker reheating, ~10-15 s) stay on the grid: a battery
// starting from standstill would only come when the spike is gone. Less at once; small changes by
// GAIN.
const RISE_MIN_W = 200;
const RISE_HOLD_MS = 20 * 1000;

// Exponential average over AVG_TAU_MS.
const average = (prev, value, dtMs) => {
  if (typeof prev !== 'number' || !(dtMs > 0)) return value;
  const k = Math.min(1, dtMs / AVG_TAU_MS);
  return prev + (k * (value - prev));
};

// The plan slot holding now, with its end. null outside the plan.
const slotAt = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return null;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  if (idx < 0 || idx >= plan.slots.length) return null;
  return {
    ...plan.slots[idx], index: idx, endMs: plan.startMs + ((idx + 1) * plan.intervalMs),
  };
};

// What to do in the mode: a block and its SoC target. null: no control ('device'). Self-consumption
// never idles: a surplus or deficit the plan did not foresee is still taken (idle and quiet hold
// slots run as zero). In both a surplus where storing it does not pay (noCharge, or below
// minSolarW) is left to the grid.
const blockFor = (mode, slot) => {
  switch (mode) {
    case 'device': return null;
    case 'xom': return { block: 'zero' };
    case 'hold': return { block: 'hold' };
    case 'idle': return { block: 'idle' };
    case 'charge': return { block: 'charge', targetSoc: 100, full: true };
    case 'discharge': return { block: 'discharge', targetSoc: 0, full: true };
    default: {
      if (!slot || !slot.block) return { block: 'zero' };
      const solar = { ...(slot.noCharge ? { noCharge: true } : {}), ...(slot.minSolarW > 0 ? { minSolarW: slot.minSolarW } : {}) };
      if (mode !== 'self_consumption') return { block: slot.block, targetSoc: slot.soc, ...solar };
      return { block: slot.block === 'idle' || slot.quiet ? 'zero' : slot.block, targetSoc: slot.soc, ...solar };
    }
  }
};

// Below the reserve the battery recharges at full power, from the grid too; not in a mode without
// grid charging (it then only keeps the reserve: no discharging).
const refillsReserve = (mode) => planOptionsFor(mode).allowGridCharge !== false;

// On/off of zero on the meter in one direction, judged on the full need (not the integrating step).
const gate = ({
  needW, avgNeedW, minW, on, lowSince, now,
}) => {
  if (!(minW > 0)) return { on: needW > 0, lowSince: null };
  if (!on) return { on: avgNeedW >= minW, lowSince: null };
  if (avgNeedW >= minW * STOP_FACTOR) return { on: true, lowSince: null };
  const since = lowSince || now;
  if (now - since >= STOP_AFTER_MS) return { on: false, lowSince: null };
  return { on: true, lowSince: since };
};

/**
 * The battery power for now.
 *
 * @param {object} o
 * @param {string} o.mode - one of MODES
 * @param {object|null} o.slot - slotAt() of the plan
 * @param {number} o.now
 * @param {number} o.gridW - grid exchange now, + import
 * @param {number} o.batteryW - battery power now: the last setpoint while controlling (the
 *   measured power lags it), else the measured power
 * @param {number} [o.nomW] - zero on the meter from NomXomStrategy (smoothed), for this battery;
 *   without it this battery corrects the grid itself (share x GAIN)
 * @param {number} [o.nomNeedW] - the raw NomXomStrategy target (gate input)
 * @param {number} [o.avgZeroW] - average() of zeroW (gate input)
 * @param {number} [o.share] - this battery's share of the grid correction (several batteries)
 * @param {number} o.socPct
 * @param {number} o.capacityKwh
 * @param {number} o.maxChargeW
 * @param {number} o.maxDischargeW - positive
 * @param {number} [o.minChargeW] - zero on the meter: smaller surplus is not taken
 * @param {number} [o.minDischargeW] - zero on the meter: smaller use is not covered
 * @param {number|null} [o.maxW] - upper bound from the import limit (capacity tariff, fuse)
 * @param {number} [o.minSocPct] - reserve: below it the battery recharges at full power (within maxW)
 * @param {boolean} [o.reserveForPeak] - maxW may discharge the battery below the reserve (peak shaving)
 * @param {number|null} [o.hardMaxW] - upper bound from the hard limit only (main fuse, contracted
 *   power): it may always discharge below the reserve
 * @param {object} [o.state] - from the previous call
 * @returns {{release: boolean, block: string|null, powerW: number|null, zeroW: number, state: object}}
 *   zeroW: the power that would bring this battery's share of the grid to 0 now (for average()).
 */
const decide = ({
  mode, slot, now, gridW, batteryW, nomW = null, nomNeedW = null, avgZeroW, share = 1, socPct, capacityKwh,
  maxChargeW, maxDischargeW, minChargeW = 0, minDischargeW = 0, maxW = null, minSocPct = 0, reserveForPeak = true,
  hardMaxW = null, state = {},
}) => {
  const zeroW = typeof nomNeedW === 'number' ? nomNeedW : batteryW - (gridW * share);
  const stepW = typeof nomW === 'number' ? nomW : batteryW - (gridW * share * GAIN);
  const plan = blockFor(mode, slot);
  if (!plan) {
    return {
      release: true, block: null, powerW: null, zeroW, state: {},
    };
  }
  const avgW = typeof avgZeroW === 'number' ? avgZeroW : zeroW;
  const charge = gate({
    needW: zeroW, avgNeedW: avgW, minW: Math.max(minChargeW, plan.minSolarW || 0), on: state.chargeOn, lowSince: state.chargeLowSince, now,
  });
  const discharge = gate({
    needW: -zeroW, avgNeedW: -avgW, minW: minDischargeW, on: state.dischargeOn, lowSince: state.dischargeLowSince, now,
  });
  const next = {
    chargeOn: charge.on, chargeLowSince: charge.lowSince, dischargeOn: discharge.on, dischargeLowSince: discharge.lowSince,
  };
  // Zero on the meter per direction: the integrating step, 0 while that direction is off.
  const solarW = zeroW > 0 && charge.on && !plan.noCharge ? Math.max(0, stepW) : 0;
  const homeW = zeroW < 0 && discharge.on ? Math.max(0, -stepW) : 0;

  // Toward the slot's SoC target by its end; 'charge'/'discharge' modes at full power.
  const remainingH = Math.max(((slot && slot.endMs) ? slot.endMs - now : 0) / 3600000, 1 / 60);
  const towardW = (target) => {
    if (typeof target !== 'number' || typeof socPct !== 'number' || !(capacityKwh > 0)) return 0;
    return (((target - socPct) / 100) * capacityKwh * 1000) / remainingH;
  };

  let powerW;
  switch (plan.block) {
    case 'zero':
      powerW = solarW - homeW;
      break;
    case 'hold':
      powerW = solarW;
      break;
    case 'charge': {
      const w = plan.full ? maxChargeW : Math.max(0, towardW(plan.targetSoc));
      powerW = socPct >= plan.targetSoc ? solarW : Math.max(w, solarW);
      break;
    }
    case 'discharge': {
      const w = plan.full ? maxDischargeW : Math.max(0, -towardW(plan.targetSoc));
      powerW = socPct <= plan.targetSoc ? -homeW : -Math.max(w, homeW);
      break;
    }
    default: // idle
      powerW = 0;
  }
  powerW = Math.max(-maxDischargeW, Math.min(maxChargeW, powerW));
  // The reserve: refilled as soon as possible (refillsReserve()), used only by the hard limit, and by the capacity
  // tariff with peak shaving.
  if (typeof socPct === 'number' && minSocPct > 0) {
    if (socPct < minSocPct && refillsReserve(mode)) powerW = maxChargeW;
    else if (powerW < 0 && socPct <= minSocPct) powerW = 0;
  }
  if (typeof maxW === 'number' && Number.isFinite(maxW)) powerW = Math.max(-maxDischargeW, Math.min(powerW, maxW));
  if (!reserveForPeak && typeof socPct === 'number' && socPct <= minSocPct) {
    const hardW = typeof hardMaxW === 'number' && Number.isFinite(hardMaxW) ? Math.min(0, hardMaxW) : 0;
    powerW = Math.max(hardW, powerW);
  }
  return {
    release: false, block: plan.block, powerW: (Math.round(powerW / 10) * 10) || 0, zeroW, state: next,
  };
};

// Send the power now? Changed enough, back to 0, or KEEPALIVE_MS since the last write.
const shouldWrite = ({
  powerW, lastW, lastTm, now, block = null,
}) => typeof lastW !== 'number' || !lastTm
  || Math.abs(powerW - lastW) >= (block === 'zero' ? WRITE_STEP_ZERO_W : WRITE_STEP_W)
  || (powerW === 0 && lastW !== 0)
  || now - lastTm >= KEEPALIVE_MS;

/**
 * The most a battery does in zero on the meter while it does not do its setpoint: what it does plus
 * FOLLOW_STEP_W, raised by that step each time it reaches it, so the other batteries take the rest.
 *
 * @param {object} o
 * @param {{dir:number, w:number}|null} o.cap - the cap so far (dir: +1 charging, -1 discharging)
 * @param {number|null} o.lagSince - since when it lags
 * @param {number|null} o.setW - last setpoint (W)
 * @param {number|null} o.setTm - its time
 * @param {number|null} o.actW - measured power (W)
 * @param {number} o.maxW - max power that way (settings)
 * @param {number} o.now
 * @returns {{cap: {dir:number, w:number}|null, lagSince: number|null}}
 */
const followCap = ({
  cap, lagSince, setW, setTm, actW, maxW, now,
}) => {
  if (typeof setW !== 'number' || typeof actW !== 'number' || Math.abs(setW) < FOLLOW_TOL_W) return { cap: null, lagSince: null };
  const dir = Math.sign(setW);
  const current = cap && cap.dir === dir ? cap : null;
  if (!setTm || now - setTm < FOLLOW_SETTLE_MS) return { cap: current, lagSince };
  const doneW = Math.max(0, dir * actW);
  if (Math.abs(setW) - doneW > Math.max(FOLLOW_TOL_W, 0.1 * Math.abs(setW))) {
    const since = lagSince || now;
    if (now - since < FOLLOW_LAG_MS) return { cap: current, lagSince: since };
    return { cap: { dir, w: doneW + FOLLOW_STEP_W }, lagSince: null };
  }
  if (!current) return { cap: null, lagSince: null };
  if (doneW < current.w - (FOLLOW_STEP_W / 2)) return { cap: current, lagSince: null };
  const w = current.w + FOLLOW_STEP_W;
  return { cap: w >= maxW ? null : { dir, w }, lagSince: null };
};

/**
 * @param {object} o
 * @param {number|null} o.prevW - this battery's zero-on-the-meter power so far; null: just entered
 * @param {number} o.targetW - its share of the need now (NomXomStrategy)
 * @param {number|null} o.riseSince - since when the need is up
 * @param {number} o.now
 * @returns {{w: number, riseSince: number|null}}
 */
const nomStep = ({
  prevW, targetW, riseSince, now,
}) => {
  if (typeof prevW !== 'number') return { w: targetW, riseSince: null };
  // The other way: first to 0 at once, the rest is new need.
  const fromW = Math.sign(targetW) === Math.sign(prevW) ? prevW : 0;
  const riseW = Math.abs(targetW) - Math.abs(fromW);
  if (riseW < -RISE_MIN_W) return { w: targetW, riseSince: null };
  if (riseW <= RISE_MIN_W) return { w: fromW + (GAIN * (targetW - fromW)), riseSince: null };
  const since = riseSince || now;
  if (now - since < RISE_HOLD_MS) return { w: fromW, riseSince: since };
  return { w: fromW + (GAIN * (targetW - fromW)), riseSince: since };
};

// The battery_action capability value: what control does now (its block), or 'none' (not
// controlled: mode device, control off).
const ACTION_OF_BLOCK = {
  zero: 'nom', hold: 'save', idle: 'rest', charge: 'charge', discharge: 'discharge',
};
const actionFor = ({ block = null, refill = false } = {}) => {
  if (!block) return 'none';
  if (refill) return 'refill';
  return ACTION_OF_BLOCK[block] || 'rest';
};

// The power zero on the meter integrates on: the decided power, within the lead of the measured.
const leadLimitW = ({
  cmdW, actW, maxChargeW, maxDischargeW, reportMs,
}) => {
  if (typeof cmdW !== 'number' || !Number.isFinite(actW) || !(reportMs > 0) || reportMs > FAST_REPORT_MS) return cmdW;
  const leadW = Math.max(LEAD_MIN_W, LEAD_SHARE * ((cmdW > actW ? maxChargeW : maxDischargeW) || 0));
  return Math.max(actW - leadW, Math.min(actW + leadW, cmdW));
};

module.exports = {
  MODES,
  followCap,
  leadLimitW,
  nomStep,
  actionFor,
  planOptionsFor,
  average,
  slotAt,
  blockFor,
  refillsReserve,
  decide,
  shouldWrite,
  STOP_AFTER_MS,
  GAIN,
};
