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
// that restarted is corrected. A manual switch of the charger starts a manual override instead:
// the plan leaves the charger alone until the override is ended, or has run its maximum time.

// Minimum time between two switch commands: protects relays and the car's charge logic, and
// retries a charger that is offline without flooding it.
const MIN_SWITCH_MS = 5 * 60 * 1000;

// A switch report with the commanded state this soon after a command is that command.
const ECHO_MS = 2 * 60 * 1000;

// Default maximum time of a manual override (setting overrideMaxHours).
const OVERRIDE_MAX_HOURS = 4;

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
 * @returns {boolean} wanted charger state
 */
const wantedState = ({
  plan, now, atHome, chargeMode,
}) => {
  if (chargeMode === 'off' || !atHome) return false;
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
 * @returns {boolean}
 */
const isManualSwitch = ({
  value, was, command, now,
}) => {
  if (typeof value !== 'boolean' || typeof was !== 'boolean' || value === was) return false;
  return !(command && command.value === value && now - command.tm < ECHO_MS);
};

/**
 * @param {object} s
 * @param {object} [s.override] - {since}
 * @returns {boolean} the override has run its maximum time
 */
const overrideExpired = ({ override, maxHours, now }) => !!override
  && now - override.since >= (maxHours > 0 ? maxHours : OVERRIDE_MAX_HOURS) * 3600 * 1000;

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
  wantedState,
  nextCommand,
  isManualSwitch,
  overrideExpired,
  shouldStartCar,
  SWITCH_CAPS,
  MIN_SWITCH_MS,
  START_CAR_AFTER_MS,
};
