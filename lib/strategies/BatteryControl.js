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

const MODES = ['smart', 'self_consumption', 'hold', 'charge', 'discharge', 'device'];

// Modes the planner (RoiStrategy) restricts.
const planOptionsFor = (mode) => (mode === 'self_consumption' ? { allowGridCharge: false, allowExport: false } : {});

// Zero on the meter below a minimum power: start on the averaged need, stop when it stays under
// STOP_FACTOR x the minimum for STOP_AFTER_MS.
const STOP_FACTOR = 0.8;
const STOP_AFTER_MS = 2 * 60 * 1000;
const AVG_TAU_MS = 60 * 1000;

// Zero on the meter integrates: new power = last power - grid x GAIN. The grid reading lags the
// setpoint by a tick or so; a gain of 1 would overshoot and oscillate, 0.5 settles in a few ticks.
const GAIN = 0.5;

// Write a new power only on this change, or again after KEEPALIVE_MS.
const WRITE_STEP_W = 50;
const KEEPALIVE_MS = 60 * 1000;

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

// What to do in the mode: a block and its SoC target. null: no control ('device').
const blockFor = (mode, slot) => {
  switch (mode) {
    case 'device': return null;
    case 'hold': return { block: 'hold' };
    case 'charge': return { block: 'charge', targetSoc: 100, full: true };
    case 'discharge': return { block: 'discharge', targetSoc: 0, full: true };
    default: return slot && slot.block ? { block: slot.block, targetSoc: slot.soc } : { block: 'zero' };
  }
};

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
 * @param {object} [o.state] - from the previous call
 * @returns {{release: boolean, block: string|null, powerW: number|null, zeroW: number, state: object}}
 *   zeroW: the power that would bring this battery's share of the grid to 0 now (for average()).
 */
const decide = ({
  mode, slot, now, gridW, batteryW, nomW = null, nomNeedW = null, avgZeroW, share = 1, socPct, capacityKwh,
  maxChargeW, maxDischargeW, minChargeW = 0, minDischargeW = 0, maxW = null, minSocPct = 0, reserveForPeak = true,
  state = {},
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
    needW: zeroW, avgNeedW: avgW, minW: minChargeW, on: state.chargeOn, lowSince: state.chargeLowSince, now,
  });
  const discharge = gate({
    needW: -zeroW, avgNeedW: -avgW, minW: minDischargeW, on: state.dischargeOn, lowSince: state.dischargeLowSince, now,
  });
  const next = {
    chargeOn: charge.on, chargeLowSince: charge.lowSince, dischargeOn: discharge.on, dischargeLowSince: discharge.lowSince,
  };
  // Zero on the meter per direction: the integrating step, 0 while that direction is off.
  const solarW = zeroW > 0 && charge.on ? Math.max(0, stepW) : 0;
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
  // The reserve: refilled as soon as possible, used only by the import limit with peak shaving.
  if (typeof socPct === 'number' && minSocPct > 0) {
    if (socPct < minSocPct) powerW = maxChargeW;
    else if (powerW < 0 && socPct <= minSocPct) powerW = 0;
  }
  if (typeof maxW === 'number' && Number.isFinite(maxW)) powerW = Math.max(-maxDischargeW, Math.min(powerW, maxW));
  if (!reserveForPeak && typeof socPct === 'number' && socPct <= minSocPct) powerW = Math.max(0, powerW);
  return {
    release: false, block: plan.block, powerW: (Math.round(powerW / 10) * 10) || 0, zeroW, state: next,
  };
};

// Send the power now? Changed enough, back to 0, or KEEPALIVE_MS since the last write.
const shouldWrite = ({
  powerW, lastW, lastTm, now,
}) => typeof lastW !== 'number' || !lastTm
  || Math.abs(powerW - lastW) >= WRITE_STEP_W
  || (powerW === 0 && lastW !== 0)
  || now - lastTm >= KEEPALIVE_MS;

module.exports = {
  MODES,
  planOptionsFor,
  average,
  slotAt,
  blockFor,
  decide,
  shouldWrite,
  STOP_AFTER_MS,
  GAIN,
};
