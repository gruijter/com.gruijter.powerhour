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

const FuseGuard = require('./FuseGuard');
const BatterySplit = require('./BatterySplit');
const { steadyEffCurve } = require('./LightPlanner');

const MODES = ['smart', 'self_consumption', 'xom', 'hold', 'idle', 'charge', 'discharge', 'device'];

const planOptionsFor = (mode) => {
  if (mode === 'self_consumption' || mode === 'xom') return { allowGridCharge: false, allowExport: false, minimizeGrid: true };
  if (mode === 'idle') return { allowGridCharge: false, allowExport: false, idle: true };
  return {};
};

const STOP_FACTOR = 0.8;
const STOP_AFTER_MS = 2 * 60 * 1000;
const AVG_TAU_MS = 60 * 1000;

const GAIN = 0.5;

const WRITE_STEP_W = 50;
const WRITE_STEP_XOM_W = 20;
const KEEPALIVE_MS = 60 * 1000;

const FOLLOW_SETTLE_MS = 10 * 1000;
const FOLLOW_LAG_MS = 75 * 1000;
const FOLLOW_TOL_W = 150;
const FOLLOW_STEP_W = 100;

const LEAD_SHARE = 0.3;
const LEAD_MIN_W = 300;
const FAST_REPORT_MS = 15 * 1000;

const RISE_MIN_W = 200;
const RISE_HOLD_MS = 20 * 1000;

const average = (prev, value, dtMs) => {
  if (typeof prev !== 'number' || !(dtMs > 0)) return value;
  const k = Math.min(1, dtMs / AVG_TAU_MS);
  return prev + (k * (value - prev));
};

const slotAt = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return null;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  if (idx < 0 || idx >= plan.slots.length) return null;
  return {
    ...plan.slots[idx], index: idx, endMs: plan.startMs + ((idx + 1) * plan.intervalMs),
  };
};

const blockFor = (mode, slot, calibrate = null) => {
  if (mode !== 'device' && calibrate === 'full') return { block: 'charge', targetSoc: Infinity, full: true };
  if (mode !== 'device' && calibrate === 'empty') return { block: 'discharge', targetSoc: -Infinity, full: true };
  switch (mode) {
    case 'device': return null;
    case 'xom': return { block: 'xom' };
    case 'hold': return { block: 'hold' };
    case 'idle': return { block: 'idle' };
    case 'charge': return { block: 'charge', targetSoc: 100, full: true };
    case 'discharge': return { block: 'discharge', targetSoc: 0, full: true };
    default: {
      if (!slot || !slot.block) return { block: mode === 'self_consumption' ? 'xom' : 'idle' };
      const solar = { ...(slot.noCharge ? { noCharge: true } : {}), ...(slot.minSolarW > 0 ? { minSolarW: slot.minSolarW } : {}) };
      if (mode !== 'self_consumption') {
        const cap = slot.block === 'xom' && slot.homeCapW > 0 ? { homeCapW: slot.homeCapW } : {};
        return {
          block: slot.block, targetSoc: slot.soc, ...solar, ...cap,
        };
      }
      return { block: slot.block === 'idle' || slot.quiet ? 'xom' : slot.block, targetSoc: slot.soc, ...solar };
    }
  }
};

const refillsReserve = (mode) => planOptionsFor(mode).allowGridCharge !== false;

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

const PULSE_FAN_W = 45;
const PULSE_START_S = 30;
const PULSE_STOP_S = 60;
const PULSE_MIN_RESPONSE_N = 3;
const PULSE_START_SHARE = 0.9;

const pulseParams = (settings, response = null) => {
  const { chargeSpeeds, dischargeSpeeds } = BatterySplit.speedsFromSettings(settings);
  const learned = response && response.standstill && response.standstill.n >= PULSE_MIN_RESPONSE_N && response.standstill.ms > 0;
  const startS = learned ? response.standstill.ms / 1000 : PULSE_START_S;
  return {
    chargeW: BatterySplit.efficientSpeed(chargeSpeeds).power,
    dischargeW: BatterySplit.efficientSpeed(dischargeSpeeds).power,
    chargeEffAt: steadyEffCurve(chargeSpeeds, 'charge'),
    dischargeEffAt: steadyEffCurve(dischargeSpeeds, 'discharge'),
    overheadWh: (PULSE_FAN_W * (startS + PULSE_STOP_S)) / 3600,
    startS,
  };
};

const pulseSavingWh = ({
  pulse, w, wh, charging,
}) => {
  const p = charging ? pulse.chargeW : pulse.dischargeW;
  if (!(p > w) || !(wh > 0)) return 0;
  const effAt = charging ? pulse.chargeEffAt : pulse.dischargeEffAt;
  const eW = Math.max(0.01, effAt(w));
  const eP = effAt(p);
  if (!(eP > 0)) return 0;
  return charging ? wh * (eP - eW) : wh * ((1 / eW) - (1 / eP));
};

const pulseStep = ({
  pulse, w, remainingH, charging, phase,
}) => {
  const p = pulse && (charging ? pulse.chargeW : pulse.dischargeW);
  if (!(p > 0) || !(w > 0)) return { w, phase: null };
  if (phase === 'on' || (phase === 'wait' && w >= p * PULSE_START_SHARE)) return { w: Math.max(w, p), phase: 'on' };
  if (w >= p * PULSE_START_SHARE) return { w, phase: null };
  const saved = pulseSavingWh({
    pulse, w, wh: w * remainingH, charging,
  });
  return saved > pulse.overheadWh ? { w: 0, phase: 'wait' } : { w, phase: null };
};

const decide = ({
  mode, slot, calibrate = null, now, gridW, batteryW, xomStepW = null, xomNeedW = null, avgXomW, share = 1, socPct, capacityKwh,
  maxChargeW, maxDischargeW, minChargeW = 0, minDischargeW = 0, maxW = null, minSocPct = 0, reserveForPeak = true,
  hardMaxW = null, minW = null, stale = false, pulse = null, state = {},
}) => {
  const xomW = typeof xomNeedW === 'number' ? xomNeedW : batteryW - (gridW * share);
  const stepW = typeof xomStepW === 'number' ? xomStepW : batteryW - (gridW * share * GAIN);
  const plan = blockFor(mode, slot, calibrate);
  if (!plan) {
    return {
      release: true, block: null, powerW: null, xomW, state: {},
    };
  }
  const avgW = typeof avgXomW === 'number' ? avgXomW : xomW;
  const charge = gate({
    needW: xomW, avgNeedW: avgW, minW: Math.max(minChargeW, plan.minSolarW || 0), on: state.chargeOn, lowSince: state.chargeLowSince, now,
  });
  const discharge = gate({
    needW: -xomW, avgNeedW: -avgW, minW: minDischargeW, on: state.dischargeOn, lowSince: state.dischargeLowSince, now,
  });
  const next = {
    chargeOn: charge.on, chargeLowSince: charge.lowSince, dischargeOn: discharge.on, dischargeLowSince: discharge.lowSince, pulseOn: false, pulseWait: false,
  };
  const solarW = xomW > 0 && charge.on && !plan.noCharge ? Math.max(0, stepW) : 0;
  const homeW = xomW < 0 && discharge.on ? Math.min(Math.max(0, -stepW), plan.homeCapW || Infinity) : 0;

  const remainingH = Math.max(((slot && slot.endMs) ? slot.endMs - now : 0) / 3600000, 1 / 60);
  const towardW = (target) => {
    if (typeof target !== 'number' || typeof socPct !== 'number' || !(capacityKwh > 0)) return 0;
    return (((target - socPct) / 100) * capacityKwh * 1000) / remainingH;
  };
  const pulsed = (w, dir) => {
    const phase = (state.pulseOn === dir && 'on') || (state.pulseWait === dir && 'wait') || null;
    const r = pulseStep({
      pulse, w, remainingH, charging: dir === 'charge', phase,
    });
    next.pulseOn = r.phase === 'on' ? dir : false;
    next.pulseWait = r.phase === 'wait' ? dir : false;
    return r.w;
  };

  let powerW;
  switch (plan.block) {
    case 'xom':
      powerW = solarW - homeW;
      break;
    case 'hold':
      powerW = solarW;
      break;
    case 'charge': {
      let w = plan.full ? maxChargeW : Math.max(0, towardW(plan.targetSoc));
      if (socPct >= plan.targetSoc) {
        powerW = plan.targetSoc >= 100 ? maxChargeW : solarW;
        break;
      }
      if (!plan.full) w = pulsed(w, 'charge');
      powerW = Math.max(w, solarW);
      break;
    }
    case 'discharge': {
      let w = plan.full ? maxDischargeW : Math.max(0, -towardW(plan.targetSoc));
      if (socPct <= plan.targetSoc) {
        powerW = plan.targetSoc <= 0 ? -maxDischargeW : -homeW;
        break;
      }
      if (!plan.full) w = pulsed(w, 'discharge');
      powerW = -Math.max(w, homeW);
      break;
    }
    default:
      powerW = 0;
  }
  powerW = Math.max(-maxDischargeW, Math.min(maxChargeW, powerW));
  if (typeof socPct === 'number' && minSocPct > 0) {
    if (socPct < minSocPct && refillsReserve(mode)) powerW = maxChargeW;
    else if (powerW < 0 && socPct <= minSocPct) powerW = 0;
  }
  if (typeof maxW === 'number' && Number.isFinite(maxW)) powerW = Math.max(-maxDischargeW, Math.min(powerW, maxW));
  if (!reserveForPeak && typeof socPct === 'number' && socPct <= minSocPct && !(calibrate === 'empty' && minSocPct <= 0)) {
    const hardW = typeof hardMaxW === 'number' && Number.isFinite(hardMaxW) ? Math.min(0, hardMaxW) : 0;
    powerW = Math.max(hardW, powerW);
  }
  const maxOk = typeof maxW !== 'number' || !Number.isFinite(maxW) || minW <= maxW;
  if (typeof minW === 'number' && Number.isFinite(minW) && maxOk) powerW = Math.min(maxChargeW, Math.max(powerW, minW));
  if (stale) powerW = FuseGuard.freeze(powerW, batteryW);
  return {
    release: false, block: plan.block, powerW: (Math.round(powerW / 10) * 10) || 0, xomW, state: next,
  };
};

const shouldWrite = ({
  powerW, lastW, lastTm, now, block = null,
}) => typeof lastW !== 'number' || !lastTm
  || Math.abs(powerW - lastW) >= (['xom', 'hold'].includes(block) ? WRITE_STEP_XOM_W : WRITE_STEP_W)
  || (powerW === 0 && lastW !== 0)
  || now - lastTm >= KEEPALIVE_MS;

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

const xomStep = ({
  prevW, targetW, riseSince, now,
}) => {
  if (typeof prevW !== 'number') return { w: targetW, riseSince: null };
  const fromW = Math.sign(targetW) === Math.sign(prevW) ? prevW : 0;
  const riseW = Math.abs(targetW) - Math.abs(fromW);
  if (riseW < -RISE_MIN_W) return { w: targetW, riseSince: null };
  if (riseW <= RISE_MIN_W) return { w: fromW + (GAIN * (targetW - fromW)), riseSince: null };
  const since = riseSince || now;
  if (now - since < RISE_HOLD_MS) return { w: fromW, riseSince: since };
  return { w: fromW + (GAIN * (targetW - fromW)), riseSince: since };
};

const ACTIONS = ['xom', 'hold', 'idle', 'charge', 'discharge'];
const actionFor = ({ block = null, refill = false, calibrate = null } = {}) => {
  if (!block) return 'none';
  if (calibrate) return 'calibrate';
  if (refill) return 'refill';
  return ACTIONS.includes(block) ? block : 'idle';
};

const leadLimitW = ({
  cmdW, actW, maxChargeW, maxDischargeW, reportMs,
}) => {
  if (typeof cmdW !== 'number' || !Number.isFinite(actW) || !(reportMs > 0) || reportMs > FAST_REPORT_MS) return cmdW;
  const leadW = Math.max(LEAD_MIN_W, LEAD_SHARE * ((cmdW > actW ? maxChargeW : maxDischargeW) || 0));
  return Math.max(actW - leadW, Math.min(actW + leadW, cmdW));
};

module.exports = {
  FAST_REPORT_MS,
  MODES,
  followCap,
  leadLimitW,
  xomStep,
  actionFor,
  planOptionsFor,
  average,
  slotAt,
  blockFor,
  refillsReserve,
  decide,
  pulseParams,
  pulseSavingWh,
  shouldWrite,
  STOP_AFTER_MS,
  GAIN,
};
