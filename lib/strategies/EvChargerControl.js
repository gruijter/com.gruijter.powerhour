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

// On/off control of the charger from the charge plan. Pure: the device switches.
//
// The wanted state is compared with the charger's actual state, so a lost command or a charger
// that restarted is corrected. A switch of the charger outside this app starts the temporary mode
// with that state (charge_temp, off_temp) instead, so the plan does not switch it back.

// Minimum time between two switch commands: protects relays and the car's charge logic, and
// retries a charger that is offline without flooding it.
const MIN_SWITCH_MS = 5 * 60 * 1000;

// A switch report with the commanded state this soon after a command is that command.
const ECHO_MS = 2 * 60 * 1000;

// evcharger_charging is a command and a status: a charger also switches it itself, on plugging in
// (auto-start) or out. A switch this close to a plug change is the charger's, not a person's.
// Also how long a switch waits to be judged, as the plug report can come after it.
const PLUG_WINDOW_MS = 2 * 60 * 1000;

// Default maximum time of a temporary mode (setting overrideMaxHours).
const OVERRIDE_MAX_HOURS = 4;

// Charge modes that last a limited time, then return to the mode before.
const TEMP_MODES = ['charge_temp', 'off_temp'];
const isTempMode = (mode) => TEMP_MODES.includes(mode);

// A charger set by current (A): watts per amp by the phases the car takes (230 V per phase).
// Unknown: 3 phases, which sets the fewest amps for a power, so never more power than planned.
const VOLT = 230;
const MAX_PHASES = 3;
const AMP_SAMPLES = 50; // kept W/A samples: the highest of them is the full phase count
const AMP_SETTLE_MS = 2 * 60 * 1000; // a sample this long after a current command
const DEFAULT_MIN_A = 6; // IEC 61851 lowest charge current, for a capability without a min
const DEFAULT_MAX_A = 32;

// Fewer phases are learned only from this many samples: a car that tapers (near full) or limits
// its power must not look like fewer phases, which would set too many amps.
const MIN_PHASE_SAMPLES = 3;
const PHASE_FIT = 0.12; // a sample within this share of whole phases; others are a tapering car

/**
 * Add a W/A sample: measured power at a set current. The car may take less (charge limit, near
 * full, cable), never more, so the highest sample is the phase count.
 */
const addAmpSample = (samples, { powerW, currentA }) => {
  const list = Array.isArray(samples) ? samples : [];
  if (!(powerW > 0) || !(currentA > 0)) return list;
  const ratio = powerW / currentA;
  if (ratio > VOLT * MAX_PHASES * 1.2) return list; // the car did not follow the command (yet)
  const phases = Math.round(ratio / VOLT);
  if (phases < 1 || Math.abs(ratio / VOLT - phases) > PHASE_FIT * phases) return list;
  return [...list, Math.round(ratio)].slice(-AMP_SAMPLES);
};

/**
 * Watts per amp from the samples, in whole phases.
 *
 * @param {number[]} samples
 * @param {boolean} [low] - when not learned: 1 phase (the lowest power), else 3 (the fewest amps)
 */
const wattsPerAmp = (samples, low = false) => {
  const list = (Array.isArray(samples) ? samples : []).filter((r) => r > 0);
  const phases = list.length ? Math.min(MAX_PHASES, Math.max(1, Math.round(Math.max(...list) / VOLT))) : 0;
  if (phases === MAX_PHASES || (phases && list.length >= MIN_PHASE_SAMPLES)) return VOLT * phases;
  return low ? VOLT : VOLT * MAX_PHASES;
};

/**
 * Current (whole A, rounded down) for a power, within the capability's min and max.
 *
 * @param {object} capObj - the current capability of the charger (min, max)
 */
const ampLimits = (capObj = {}) => ({
  minA: typeof capObj.min === 'number' && capObj.min > 0 ? capObj.min : DEFAULT_MIN_A,
  maxA: typeof capObj.max === 'number' && capObj.max > 0 ? capObj.max : DEFAULT_MAX_A,
});
const toCurrent = ({
  powerW, wpa, minA, maxA,
}) => Math.max(minA, Math.min(maxA, Math.floor(powerW / wpa)));

/**
 * The charger's kWh meter: the import meter of its Homey energy object first (e.g. Zaptec
 * meter_power.signed_meter_value, Peblar meter_power.charged), else meter_power. One that holds a
 * number first: some apps declare meter_power and never set it (nl.xseth.wallbox).
 *
 * @param {object} device - HomeyAPI device: capabilities, capabilitiesObj, energyObj
 * @param {boolean} [declared] - else a declared one without a value yet (e.g. after a reboot)
 * @returns {string|null}
 */
const meterCap = (device, declared = false) => {
  const caps = (device && device.capabilities) || [];
  const energy = (device && (device.energyObj || device.energy)) || {};
  const ids = [energy.meterPowerImportedCapability, 'meter_power'].filter((cap) => cap && caps.includes(cap));
  return ids.find((cap) => typeof device.capabilitiesObj?.[cap]?.value === 'number')
    || (declared && ids[0]) || null;
};

/**
 * The own charged kWh counter from a source meter that can restart: a session meter
 * (nl.xseth.wallbox) or a yearly one (com.zaptec meter_power) drops back towards 0. The counter
 * is the source plus an offset, which changes only on a restart or a new source, so the anchor
 * is stored only then. With V2X a drop is discharging.
 *
 * @param {object|null} o.anchor - { id, cap, offset } stored
 * @param {string} o.id - charger device id
 * @param {string} o.cap
 * @param {number} o.value - the source meter now
 * @param {number|null} o.last - the source meter before in this run, null at the first reading
 * @param {number} o.hidden - the counter now (meter_power_hidden)
 * @param {boolean} [o.v2x]
 * @returns {{anchor, total: number, last: number, changed?: boolean, restarted?: boolean, dip?: boolean}}
 */
const meterTotal = ({
  anchor, id, cap, value, last, hidden, v2x,
}) => {
  const fresh = () => ({
    anchor: { id, cap, offset: hidden - value }, total: hidden, last: value, changed: true,
  });
  if (!anchor || anchor.id !== id || anchor.cap !== cap || typeof anchor.offset !== 'number') return fresh();
  if (typeof last !== 'number') {
    // First reading of this run: also counts what was charged while the app was down, unless the
    // counter would go back (a restart meanwhile).
    const total = value + anchor.offset;
    return total >= hidden ? { anchor, total, last: value } : fresh();
  }
  if (v2x || value >= last) return { anchor, total: value + anchor.offset, last: value };
  // A small drop (stale or rounded report) or 0 (an app that restarts) is no restart.
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

/**
 * Does the plan (ChargeDeviceHelpers.latestPlan) want power at `now`? A slot's `duration`
 * minutes run from the slot start, or for the current slot from when the plan was made.
 */
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

/**
 * The next charging period of the plan: the first slot with power from now, with the slots after
 * it that follow with a gap of at most one slot (one session, e.g. on solar surplus). null when the
 * plan does not charge anymore.
 *
 * @returns {{startMs: number, endMs: number, minutes: number}|null} startMs <= now when it already
 *   started; minutes: charging time in it (less than the span when there are gaps)
 */
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

/**
 * The plan's slot at now, or null.
 */
const slotAt = (plan, now) => {
  if (!plan || !Array.isArray(plan.slots) || !(plan.intervalMs > 0)) return null;
  const idx = Math.floor((now - plan.startMs) / plan.intervalMs);
  return idx >= 0 && idx < plan.slots.length ? plan.slots[idx] : null;
};

// Measured solar surplus: starting needs this share of the power it takes, staying on less, so
// a passing cloud does not switch the charger. MIN_SWITCH_MS still limits the switching.
const SOLAR_START_SHARE = 0.95;
const SOLAR_KEEP_SHARE = 0.75;

/**
 * Charging on solar surplus, checked against the measured surplus: the plan's cheap extras on
 * solar (slot.solarExtra), and surplus the forecast missed (opportunistic, when allowed).
 * Never for charging that is needed (trips, reserve, floor).
 *
 * @param {object} s
 * @param {boolean} s.wanted - wantedState() from the plan
 * @param {object|null} s.slot - slotAt()
 * @param {number|null} s.surplusW - measured surplus (export + this charger's own power), smoothed
 * @param {number} s.needW - power that must come from the surplus: the full charge power, or a
 *   variable charger's lowest power
 * @param {boolean} s.isOn - charging on surplus now (for the keep threshold)
 * @param {boolean} s.opportunistic - may start on surplus the plan did not expect
 * @returns {{wanted: boolean, solar: boolean}} solar: charging that follows the surplus
 */
const solarGate = ({
  wanted, slot, surplusW, needW, isOn, opportunistic,
}) => {
  const planSolar = wanted && !!(slot && slot.solarExtra);
  if (!planSolar && (wanted || !opportunistic)) return { wanted, solar: false };
  // Nothing measured (no grid meter): the plan as it is.
  if (typeof surplusW !== 'number' || !(needW > 0)) return { wanted, solar: planSolar };
  const enough = surplusW >= needW * (isOn ? SOLAR_KEEP_SHARE : SOLAR_START_SHARE);
  return { wanted: enough, solar: enough };
};

/**
 * Power (W) for a charger with a setable power: the measured surplus when following it, else the
 * plan's power for the slot. Between minW and maxW, in steps of 100 W.
 */
const targetPower = ({
  solar, surplusW, slot, minW, maxW,
}) => {
  const raw = solar && typeof surplusW === 'number' ? surplusW : ((slot && slot.power) || maxW);
  return Math.round(Math.max(minW, Math.min(maxW, raw)) / 100) * 100;
};

/**
 * @returns {boolean} wanted charger state
 */
const wantedState = ({
  plan, now, atHome, chargeMode,
}) => {
  if (chargeMode === 'off' || chargeMode === 'off_temp' || !atHome) return false;
  // Temporarily on: on, whatever the plan says; the car stops by itself when full.
  if (chargeMode === 'charge_temp') return true;
  return planWantsPower(plan, now);
};

/**
 * @param {object} s
 * @param {boolean|null} s.actual - the charger's reported state; unknown falls back to lastWanted
 * @returns {boolean|null} the command to send now, or null for none
 */
const nextCommand = ({
  wanted, actual, lastWanted, lastCommandTm, now,
}) => {
  const current = typeof actual === 'boolean' ? actual : lastWanted;
  if (wanted === current) return null;
  if (typeof lastCommandTm === 'number' && (now - lastCommandTm) < MIN_SWITCH_MS) return null;
  return wanted;
};

/**
 * Was a change of the charger's state made by someone else than this device?
 *
 * @param {object} s
 * @param {object} [s.command] - {value, tm}: the last command sent
 * @param {number} s.now - when the switch was reported
 * @param {number} [s.plugChangeTm] - last change of the charger's or the car's plug state
 * @param {boolean} [s.carFull] - the car is at its own charge limit
 * @returns {boolean}
 */
const isManualSwitch = ({
  value, was, command, now, plugChangeTm, carFull,
}) => {
  if (typeof value !== 'boolean' || typeof was !== 'boolean' || value === was) return false;
  if (command && command.value === value && now - command.tm < ECHO_MS) return false;
  if (typeof plugChangeTm === 'number' && Math.abs(now - plugChangeTm) < PLUG_WINDOW_MS) return false;
  // Off with the car at its own limit: the car stopped, not a person.
  return !(value === false && carFull);
};

/**
 * @param {object} tempMode - {since}
 * @returns {number} when a temporary mode ends (ms)
 */
const tempModeEnd = (tempMode, maxHours) => tempMode.since
  + (maxHours > 0 ? maxHours : OVERRIDE_MAX_HOURS) * 3600 * 1000;

/**
 * @param {object} s
 * @param {object} [s.override] - {since}: the temporary mode
 * @returns {boolean} the temporary mode has run its maximum time
 */
const overrideExpired = ({ override, maxHours, now }) => !!override && now >= tempModeEnd(override, maxHours);

// Some cars (seen on a Kia e-Niro) sometimes do not start charging when the charger switches on.
// Then the car itself is told to start, through its car app.
const START_CAR_AFTER_MS = 60 * 1000;
const START_CAR_RETRY_MS = 15 * 60 * 1000;
const START_CAR_MAX_TRIES = 2;

/**
 * Should the car be told to start charging? The charger is on, but the car has taken no power
 * since, while it is plugged in (or not known to be unplugged) and below its own charge limit.
 *
 * @param {object} s
 * @param {object} [s.tries] - {since, count, lastTm}: start commands for this switch-on
 * @returns {boolean}
 */
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

// Standby (setting standbyOn), for a charger without plug state: on while no car is detected, so
// plugging in shows as power. With a car detected the plan switches; off for PROBE_AFTER_MS, a
// probe switches it on to see if the car is still connected.
const PROBE_AFTER_MS = 3 * 3600 * 1000;
const PROBE_MS = 5 * 60 * 1000;

/**
 * Is a car connected, from the charger's power? true on power, false when on for PROBE_MS
 * without power.
 *
 * @returns {boolean|null} `plugged` unchanged when nothing tells
 */
const detectPlugged = ({
  plugged, now, powerW, switchOn, switchOnSince, lastChargingTm,
}) => {
  if (typeof powerW === 'number' && powerW > CHARGING_POWER_W) return true;
  if (switchOn !== true || typeof switchOnSince !== 'number') return plugged;
  const lastActive = Math.max(switchOnSince, typeof lastChargingTm === 'number' ? lastChargingTm : 0);
  return now - lastActive >= PROBE_MS ? false : plugged;
};

/**
 * @param {object} s
 * @param {boolean} s.wanted - from the plan
 * @param {boolean|null} s.plugged - detectPlugged()
 * @param {number|null} s.switchOffSince - ms since the charger is off
 * @param {number|null} s.probeSince - ms since the running probe started
 * @returns {{wanted: boolean, probeSince: number|null, probeEnded: boolean}} probeEnded: the car
 *   took power, back to the plan without waiting MIN_SWITCH_MS (the probe is not the plan)
 */
const standbyState = ({
  wanted, plugged, now, switchOn, switchOffSince, probeSince, lastChargingTm,
}) => {
  if (plugged !== true) return { wanted: true, probeSince: null, probeEnded: false };
  // A probe runs until the car takes power (detectPlugged() ends it when it does not).
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
  isTempMode,
  tempModeEnd,
  overrideExpired,
  shouldStartCar,
  detectPlugged,
  standbyState,
  AMP_SETTLE_MS,
  addAmpSample,
  wattsPerAmp,
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
