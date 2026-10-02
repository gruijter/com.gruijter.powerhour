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

// Switch capabilities, in order of preference. evcharger_charging is Homey's setable start/stop
// for the evcharger class (checked in homey-lib); onoff covers smart plugs.
const SWITCH_CAPS = ['evcharger_charging', 'onoff'];

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
  SWITCH_CAPS,
  MIN_SWITCH_MS,
  PLUG_WINDOW_MS,
  START_CAR_AFTER_MS,
};
