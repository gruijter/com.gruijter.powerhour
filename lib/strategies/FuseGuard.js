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
// charge or discharge), EV chargers are not switched on again. At least 3 telegrams of a 10 s DSMR4
// meter, and 3 of the source's own (learned) interval, at most STALE_MAX_MS.
const STALE_MS = 30 * 1000;
const STALE_MAX_MS = 5 * 60 * 1000;
const STALE_INTERVALS = 3;
// Import above the limit this long (the batteries did not suffice): an EV charger is cut or switched off.
const SHED_AFTER_MS = 30 * 1000;
// A phase overload this long without relief: learned phases (PhaseLearning) are not trusted, for
// DISTRUST_HOLD_MS.
const DISTRUST_AFTER_MS = 60 * 1000;
const DISTRUST_HOLD_MS = 60 * 60 * 1000;
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
// A released EV charger is switched on this long after its reservation: the batteries first.
const RELEASE_LEAD_MS = 15 * 1000;
// Timeline notification of a fuse protection at most once per this period.
const NOTIFY_MS = 6 * 60 * 60 * 1000;

// The fuse rating (W) less the margin (setting fuseMarginPct, %).
const withMargin = (limitW, marginPct) => {
  const pct = Number.isFinite(Number(marginPct)) ? Math.max(0, Math.min(50, Number(marginPct))) : DEFAULT_MARGIN_PCT;
  return Math.round(limitW * (1 - (pct / 100)));
};

const isStale = ({ tm, now, intervalMs = 0 }) => typeof tm === 'number'
  && now - tm > Math.min(STALE_MAX_MS, Math.max(STALE_MS, STALE_INTERVALS * (Number(intervalMs) || 0)));

// Average interval (ms) between grid readings, from the previous average and one interval.
const readingInterval = (prevMs, dtMs) => {
  if (!(dtMs > 0)) return prevMs || 0;
  const dt = Math.min(dtMs, STALE_MAX_MS);
  return prevMs > 0 ? (0.9 * prevMs) + (0.1 * dt) : dt;
};

/**
 * One grid reading: is an EV charger to be switched off now?
 *
 * @param {object} o
 * @param {number} o.importW - + import
 * @param {number|null} o.limitW - hard import limit, null: none
 * @param {number} [o.overW] - instead of importW/limitW: the overload (W), >0 over
 * @param {number|null} o.overSince - from the previous step
 * @returns {{overSince: number|null, shed: boolean}} after a shed the caller restarts overSince
 */
const overloadStep = ({
  importW, limitW, overW, now, overSince,
}) => {
  const over = typeof overW === 'number' ? overW > 0 : limitW > 0 && importW > limitW;
  if (!over) return { overSince: null, shed: false };
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

// An EV charger's measured power (W), 0 unknown.
const chargerPowerW = (charger) => Math.max(0, Number(charger && charger.livePowerW) || 0);

// The phases a device takes power from (spec): { n, set, powerW }. set: phase indexes (0-2), null
// unknown which. n: phase count, null unknown; then 3 above one phase's limit, else 1 (worst case).
const PHASES = 3;
const phaseCount = (spec, limitW) => spec.n || (spec.powerW > limitW ? PHASES : 1);

// w (W) of a device on spec per phase: on its phases; unknown which, on each (worst case).
const perPhaseW = (w, spec = {}, limitW = Infinity) => {
  const each = w / phaseCount(spec, limitW);
  return [0, 1, 2].map((i) => (!spec.set || spec.set.includes(i) ? each : 0));
};

// Extra import (W) possible for a device on spec, from the phase readings (W, + import) and the
// limit of one phase: on its most loaded phase, times its phases. reservedW: per phase, or on each.
const phaseRoomW = ({
  phaseW, limitW, spec = {}, reservedW = 0,
}) => {
  const reserved = (i) => (Array.isArray(reservedW) ? reservedW[i] || 0 : reservedW);
  const room = phaseW.map((w, i) => limitW - CONTROL_RESERVE_W - reserved(i) - Math.max(0, w));
  const on = spec.set || room.map((_, i) => i);
  return phaseCount(spec, limitW) * Math.min(...on.map((i) => room[i]));
};

// The cut (W) of a device on spec that brings its overloaded phases back to the limit. 0: it takes
// from none of them. phaseOverW: import above the limit per phase (W, <=0 none). Unknown phases: 3.
const phaseCutW = ({ phaseOverW, spec = {} }) => {
  const on = spec.set || phaseOverW.map((_, i) => i);
  const over = Math.max(0, ...on.map((i) => phaseOverW[i]));
  return over > 0 ? over * (spec.n || PHASES) : 0;
};

// Two devices may take from the same phase (unknown phases: always).
const phasesOverlap = (a = {}, b = {}) => !a.set || !b.set || a.set.some((i) => b.set.includes(i));

// Grid reading stale: no more charge or discharge than now, no change of direction.
const freeze = (powerW, batteryW) => Math.max(Math.min(0, batteryW), Math.min(Math.max(0, batteryW), powerW));

module.exports = {
  withMargin,
  isStale,
  readingInterval,
  overloadStep,
  mayRelease,
  freeze,
  reduceTo,
  raiseCap,
  chargerPowerW,
  perPhaseW,
  phaseRoomW,
  phaseCutW,
  phasesOverlap,
  STALE_MS,
  CONTROL_RESERVE_W,
  RAISE_AFTER_MS,
  RESERVE_MS,
  RELEASE_LEAD_MS,
  NOTIFY_MS,
  SHED_AFTER_MS,
  SHED_HOLD_MS,
  DISTRUST_AFTER_MS,
  DISTRUST_HOLD_MS,
  DEFAULT_MARGIN_PCT,
};
