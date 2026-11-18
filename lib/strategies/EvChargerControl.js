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

const { CHARGING_POWER_W } = require('./EvPresence');

const MIN_SWITCH_MS = 5 * 60 * 1000;

const ECHO_MS = 2 * 60 * 1000;

const PLUG_WINDOW_MS = 2 * 60 * 1000;

const OVERRIDE_MAX_HOURS = 4;

const MODES = ['scheduled_price', 'solar_only', 'fast_charge', 'off'];
const LEGACY_MODES = { charge_temp: 'fast_charge', off_temp: 'off' };
const baseMode = (mode) => LEGACY_MODES[mode] || mode;

const VOLT = 230;
const MAX_PHASES = 3;
const AMP_SAMPLES = 50;
const AMP_SETTLE_MS = 2 * 60 * 1000;
const DEFAULT_MIN_A = 6;
const DEFAULT_MAX_A = 32;

const MIN_PHASE_SAMPLES = 3;
const PHASE_FIT = 0.12;

const addAmpSample = (samples, { powerW, currentA }) => {
  const list = Array.isArray(samples) ? samples : [];
  if (!(powerW > 0) || !(currentA > 0)) return list;
  const ratio = powerW / currentA;
  if (ratio > VOLT * MAX_PHASES * 1.2) return list;
  const phases = Math.round(ratio / VOLT);
  if (phases < 1 || Math.abs(ratio / VOLT - phases) > PHASE_FIT * phases) return list;
  return [...list, Math.round(ratio)].slice(-AMP_SAMPLES);
};

const learnedPhases = (samples) => {
  const list = (Array.isArray(samples) ? samples : []).filter((r) => r > 0);
  const phases = list.length ? Math.min(MAX_PHASES, Math.max(1, Math.round(Math.max(...list) / VOLT))) : 0;
  return phases === MAX_PHASES || (phases && list.length >= MIN_PHASE_SAMPLES) ? phases : 0;
};

const wattsPerAmp = (samples, low = false) => {
  const phases = learnedPhases(samples);
  if (phases) return VOLT * phases;
  return low ? VOLT : VOLT * MAX_PHASES;
};

const ampLimits = (capObj = {}) => ({
  minA: typeof capObj.min === 'number' && capObj.min > 0 ? capObj.min : DEFAULT_MIN_A,
  maxA: typeof capObj.max === 'number' && capObj.max > 0 ? capObj.max : DEFAULT_MAX_A,
});
const toCurrent = ({
  powerW, wpa, minA, maxA,
}) => Math.max(minA, Math.min(maxA, Math.floor(powerW / wpa)));

const meterCap = (device, declared = false) => {
  const caps = (device && device.capabilities) || [];
  const energy = (device && (device.energyObj || device.energy)) || {};
  const ids = [energy.meterPowerImportedCapability, 'meter_power'].filter((cap) => cap && caps.includes(cap));
  return ids.find((cap) => typeof device.capabilitiesObj?.[cap]?.value === 'number')
    || (declared && ids[0]) || null;
};

const meterTotal = ({
  anchor, id, cap, value, last, hidden, v2x,
}) => {
  const fresh = () => ({
    anchor: { id, cap, offset: hidden - value }, total: hidden, last: value, changed: true,
  });
  if (!anchor || anchor.id !== id || anchor.cap !== cap || typeof anchor.offset !== 'number') return fresh();
  if (typeof last !== 'number') {
    const total = value + anchor.offset;
    return total >= hidden ? { anchor, total, last: value } : fresh();
  }
  if (v2x || value >= last) return { anchor, total: value + anchor.offset, last: value };
  if (value <= 0 || value >= last / 2) {
    return {
      anchor, total: last + anchor.offset, last, dip: true,
    };
  }
  const before = last + anchor.offset;
  return {
    anchor: { id, cap, offset: before }, total: before + value, last: value, changed: true, restarted: true,
  };
};

const planCovers = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return false;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  return idx >= 0 && idx < plan.slots.length;
};

const planWantsPower = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return false;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  if (idx < 0 || idx >= plan.slots.length) return false;
  const slot = plan.slots[idx];
  if (!slot || !(slot.power > 0) || !(slot.duration > 0)) return false;
  const slotStart = plan.startMs + idx * plan.intervalMs;
  const runStart = idx === 0 ? Math.max(slotStart, plan.planTm || slotStart) : slotStart;
  return now < runStart + slot.duration * 60 * 1000;
};

const nextChargeWindow = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return null;
  const run = (idx) => {
    const slot = plan.slots[idx];
    if (!slot || !(slot.power > 0) || !(slot.duration > 0)) return null;
    const slotStart = plan.startMs + idx * plan.intervalMs;
    const startMs = idx === 0 ? Math.max(slotStart, plan.planTm || slotStart) : slotStart;
    return { startMs, endMs: startMs + slot.duration * 60 * 1000 };
  };
  let window = null;
  for (let idx = Math.max(0, Math.floor((now - plan.startMs) / plan.intervalMs)); idx < plan.slots.length; idx += 1) {
    const r = run(idx);
    if (!window) {
      if (r && r.endMs > now) window = { ...r, minutes: (r.endMs - Math.max(r.startMs, now)) / 60000 };
    } else if (r && r.startMs - window.endMs <= plan.intervalMs) {
      window.endMs = r.endMs;
      window.minutes += (r.endMs - r.startMs) / 60000;
    } else if (!r && plan.startMs + (idx + 1) * plan.intervalMs - window.endMs > plan.intervalMs) {
      break;
    }
  }
  if (window) window.minutes = Math.round(window.minutes);
  return window;
};

const slotAt = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return null;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  return idx >= 0 && idx < plan.slots.length ? plan.slots[idx] : null;
};

const SOLAR_START_SHARE = 0.95;
const SOLAR_KEEP_SHARE = 0.75;

const solarGate = ({
  wanted, slot, surplusW, needW, isOn, opportunistic,
}) => {
  const planSolar = wanted && !!(slot && slot.solarExtra);
  if (!planSolar && (wanted || !opportunistic)) return { wanted, solar: false };
  if (typeof surplusW !== 'number' || !(needW > 0)) return { wanted, solar: planSolar };
  const enough = surplusW >= needW * (isOn ? SOLAR_KEEP_SHARE : SOLAR_START_SHARE);
  return { wanted: enough, solar: enough };
};

const targetPower = ({
  solar, surplusW, slot, minW, maxW,
}) => {
  const raw = solar && typeof surplusW === 'number' ? surplusW : ((slot && slot.power) || maxW);
  return Math.round(Math.max(minW, Math.min(maxW, raw)) / 100) * 100;
};

const wantedState = ({
  plan, now, atHome, chargeMode, forceOn = false,
}) => {
  if (chargeMode === 'off' || !atHome) return false;
  if (chargeMode === 'fast_charge' && (forceOn || !planCovers(plan, now))) return true;
  return planWantsPower(plan, now);
};

const nextCommand = ({
  wanted, actual, lastWanted, lastCommandTm, now,
}) => {
  const current = typeof actual === 'boolean' ? actual : lastWanted;
  if (wanted === current) return null;
  if (typeof lastCommandTm === 'number' && (now - lastCommandTm) < MIN_SWITCH_MS) return null;
  return wanted;
};

const isManualSwitch = ({
  value, was, command, now, plugChangeTm, carFull, standbyNoCar,
}) => {
  if (typeof value !== 'boolean' || typeof was !== 'boolean' || value === was) return false;
  if (command && command.value === value && now - command.tm < ECHO_MS) return false;
  if (typeof plugChangeTm === 'number' && Math.abs(now - plugChangeTm) < PLUG_WINDOW_MS) return false;
  return !(value === false && (carFull || standbyNoCar));
};

const tempModeEnd = (tempMode, maxHours) => {
  const fallback = maxHours > 0 ? maxHours : OVERRIDE_MAX_HOURS;
  return tempMode.since + (tempMode.hours > 0 ? tempMode.hours : fallback) * 3600 * 1000;
};

const overrideExpired = ({ override, maxHours, now }) => !!override && now >= tempModeEnd(override, maxHours);

const START_CAR_AFTER_MS = 60 * 1000;
const START_CAR_RETRY_MS = 15 * 60 * 1000;
const START_CAR_MAX_TRIES = 2;

const shouldStartCar = ({
  now, switchOn, switchOnSince, lastChargingTm, powerW, atHome, carPlugged, soc, carLimit, tries,
}) => {
  if (switchOn !== true || typeof switchOnSince !== 'number' || !atHome || carPlugged === false) return false;
  if (now - switchOnSince < START_CAR_AFTER_MS) return false;
  if (typeof lastChargingTm === 'number' && lastChargingTm >= switchOnSince) return false;
  if (typeof powerW === 'number' && powerW > CHARGING_POWER_W) return false;
  if (typeof soc !== 'number' || soc >= (typeof carLimit === 'number' ? carLimit : 100)) return false;
  if (!tries || tries.since !== switchOnSince) return true;
  return tries.count < START_CAR_MAX_TRIES && now - tries.lastTm >= START_CAR_RETRY_MS;
};

const PROBE_AFTER_MS = 3 * 3600 * 1000;
const PROBE_MS = 5 * 60 * 1000;

const detectPlugged = ({
  plugged, now, powerW, switchOn, switchOnSince, lastChargingTm,
}) => {
  if (typeof powerW === 'number' && powerW > CHARGING_POWER_W) return true;
  if (switchOn !== true || typeof switchOnSince !== 'number') return plugged;
  const lastActive = Math.max(switchOnSince, typeof lastChargingTm === 'number' ? lastChargingTm : 0);
  return now - lastActive >= PROBE_MS ? false : plugged;
};

const standbyState = ({
  wanted, plugged, now, switchOn, switchOffSince, probeSince, lastChargingTm,
}) => {
  if (plugged !== true) return { wanted: true, probeSince: null, probeEnded: false };
  if (typeof probeSince === 'number') {
    if (!(typeof lastChargingTm === 'number' && lastChargingTm >= probeSince)) return { wanted: true, probeSince, probeEnded: false };
    return { wanted, probeSince: null, probeEnded: true };
  }
  if (!wanted && switchOn === false && typeof switchOffSince === 'number' && now - switchOffSince >= PROBE_AFTER_MS) {
    return { wanted: true, probeSince: now, probeEnded: false };
  }
  return { wanted, probeSince: null, probeEnded: false };
};

module.exports = {
  planWantsPower,
  nextChargeWindow,
  slotAt,
  solarGate,
  targetPower,
  wantedState,
  nextCommand,
  isManualSwitch,
  MODES,
  baseMode,
  OVERRIDE_MAX_HOURS,
  tempModeEnd,
  overrideExpired,
  shouldStartCar,
  detectPlugged,
  standbyState,
  AMP_SETTLE_MS,
  addAmpSample,
  wattsPerAmp,
  learnedPhases,
  ampLimits,
  toCurrent,
  meterCap,
  meterTotal,
  MIN_SWITCH_MS,
  PLUG_WINDOW_MS,
  START_CAR_AFTER_MS,
  PROBE_AFTER_MS,
  PROBE_MS,
};
