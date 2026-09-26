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

// On/off control of the charger from the charge plan. Pure: the device switches.
//
// Only a change of the wanted state is sent. A manual switch of the charger therefore holds until
// the plan wants something else, and a charger that is offline is retried, not flooded.

// Minimum time between two switch commands: protects relays and the car's charge logic.
const MIN_SWITCH_MS = 5 * 60 * 1000;

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
 * @returns {boolean|null} the command to send now, or null for none
 */
const nextCommand = ({
  wanted, lastWanted, lastCommandTm, now,
}) => {
  if (wanted === lastWanted) return null;
  if (typeof lastCommandTm === 'number' && (now - lastCommandTm) < MIN_SWITCH_MS) return null;
  return wanted;
};

module.exports = {
  planWantsPower,
  wantedState,
  nextCommand,
  SWITCH_CAPS,
  MIN_SWITCH_MS,
};
