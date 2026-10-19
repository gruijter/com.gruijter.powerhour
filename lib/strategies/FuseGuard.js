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

// Main fuse protection beyond the batteries. Pure: the grid and EV devices act.

// No grid reading for this long from a realtime source: the batteries keep their power (no more
// charge or discharge), EV chargers are not switched on again. 3 telegrams of a 10 s DSMR4 meter.
const STALE_MS = 30 * 1000;
// Import above the limit this long (the batteries did not suffice): an EV charger is cut or switched off.
const SHED_AFTER_MS = 30 * 1000;
// A switched off EV charger stays off at least this long.
const SHED_HOLD_MS = 10 * 60 * 1000;
const DEFAULT_MARGIN_PCT = 5;
// Battery control stays this far below the limit, so its settling noise is no overload.
const CONTROL_RESERVE_W = 100;
// A variable EV charger's limit is raised no sooner than this after a cut, and keeps this room.
const RAISE_AFTER_MS = 2 * 60 * 1000;
const RAISE_ROOM_W = 300;
// An EV charger released or raised: its extra power is reserved this long, so the batteries make
// room before the car takes it (charger and car start in seconds to tens of seconds).
const RESERVE_MS = 60 * 1000;
// Timeline notification of a fuse protection at most once per this period.
const NOTIFY_MS = 6 * 60 * 60 * 1000;

// The fuse rating (W) less the margin (setting fuseMarginPct, %).
const withMargin = (limitW, marginPct) => {
  const pct = Number.isFinite(Number(marginPct)) ? Math.max(0, Math.min(50, Number(marginPct))) : DEFAULT_MARGIN_PCT;
  return Math.round(limitW * (1 - (pct / 100)));
};

const isStale = ({ tm, now }) => typeof tm === 'number' && now - tm > STALE_MS;

/**
 * One grid reading: is an EV charger to be switched off now?
 *
 * @param {object} o
 * @param {number} o.importW - + import
 * @param {number|null} o.limitW - hard import limit, null: none
 * @param {number|null} o.overSince - from the previous step
 * @returns {{overSince: number|null, shed: boolean}} after a shed the caller restarts overSince
 */
const overloadStep = ({
  importW, limitW, now, overSince,
}) => {
  if (!(limitW > 0) || !(importW > limitW)) return { overSince: null, shed: false };
  const since = typeof overSince === 'number' ? overSince : now;
  return { overSince: since, shed: now - since >= SHED_AFTER_MS };
};

// A switched off EV charger may charge again: held long enough, and room for its power.
const mayRelease = ({
  shedTm, now, headroomW, needW, stale,
}) => !stale && now - shedTm >= SHED_HOLD_MS && typeof headroomW === 'number' && headroomW >= needW;

// A variable EV charger: its power less the overload. null: below its minimum, switch it off.
const reduceTo = ({ currentW, overW, minW }) => {
  const w = Math.floor((currentW - overW) / 100) * 100;
  return w >= minW ? w : null;
};

// The limit of a cut variable EV charger with the room now. null: its full power fits again.
const raiseCap = ({ capW, headroomW, maxW }) => {
  if (!(headroomW > RAISE_ROOM_W)) return capW;
  const w = capW + headroomW - RAISE_ROOM_W;
  return w >= maxW ? null : Math.max(capW, Math.floor(w / 100) * 100);
};

// Grid reading stale: no more charge or discharge than now, no change of direction.
const freeze = (powerW, batteryW) => Math.max(Math.min(0, batteryW), Math.min(Math.max(0, batteryW), powerW));

module.exports = {
  withMargin,
  isStale,
  overloadStep,
  mayRelease,
  freeze,
  reduceTo,
  raiseCap,
  STALE_MS,
  CONTROL_RESERVE_W,
  RAISE_AFTER_MS,
  RESERVE_MS,
  NOTIFY_MS,
  SHED_AFTER_MS,
  SHED_HOLD_MS,
  DEFAULT_MARGIN_PCT,
};
