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

const STALE_MS = 30 * 1000;
const STALE_MAX_MS = 5 * 60 * 1000;
const STALE_INTERVALS = 3;
const SHED_AFTER_MS = 30 * 1000;
const DISTRUST_AFTER_MS = 60 * 1000;
const DISTRUST_HOLD_MS = 60 * 60 * 1000;
const SHED_HOLD_MS = 10 * 60 * 1000;
const DEFAULT_MARGIN_PCT = 5;
const CONTROL_RESERVE_W = 100;
const RAISE_AFTER_MS = 2 * 60 * 1000;
const RAISE_ROOM_W = 300;
const RESERVE_MS = 60 * 1000;
const RELEASE_LEAD_MS = 15 * 1000;
const NOTIFY_MS = 6 * 60 * 60 * 1000;

const withMargin = (limitW, marginPct) => {
  const pct = Number.isFinite(Number(marginPct)) ? Math.max(0, Math.min(50, Number(marginPct))) : DEFAULT_MARGIN_PCT;
  return Math.round(limitW * (1 - (pct / 100)));
};

const isStale = ({ tm, now, intervalMs = 0 }) => typeof tm === 'number'
  && now - tm > Math.min(STALE_MAX_MS, Math.max(STALE_MS, STALE_INTERVALS * (Number(intervalMs) || 0)));

const readingInterval = (prevMs, dtMs) => {
  if (!(dtMs > 0)) return prevMs || 0;
  const dt = Math.min(dtMs, STALE_MAX_MS);
  return prevMs > 0 ? (0.9 * prevMs) + (0.1 * dt) : dt;
};

const overloadStep = ({
  importW, limitW, overW, now, overSince,
}) => {
  const over = typeof overW === 'number' ? overW > 0 : limitW > 0 && importW > limitW;
  if (!over) return { overSince: null, shed: false };
  const since = typeof overSince === 'number' ? overSince : now;
  return { overSince: since, shed: now - since >= SHED_AFTER_MS };
};

const mayRelease = ({
  shedTm, now, headroomW, needW, stale,
}) => !stale && now - shedTm >= SHED_HOLD_MS && typeof headroomW === 'number' && headroomW >= needW;

const reduceTo = ({ currentW, overW, minW }) => {
  const w = Math.floor((currentW - overW) / 100) * 100;
  return w >= minW ? w : null;
};

const raiseCap = ({ capW, headroomW, maxW }) => {
  if (!(headroomW > RAISE_ROOM_W)) return capW;
  const w = capW + headroomW - RAISE_ROOM_W;
  return w >= maxW ? null : Math.max(capW, Math.floor(w / 100) * 100);
};

const chargerPowerW = (charger) => Math.max(0, Number(charger && charger.livePowerW) || 0);

const PHASES = 3;
const phaseCount = (spec, limitW) => spec.n || (spec.powerW > limitW ? PHASES : 1);

const perPhaseW = (w, spec = {}, limitW = Infinity) => {
  const each = w / phaseCount(spec, limitW);
  return [0, 1, 2].map((i) => (!spec.set || spec.set.includes(i) ? each : 0));
};

const phaseRoomW = ({
  phaseW, limitW, spec = {}, reservedW = 0,
}) => {
  const reserved = (i) => (Array.isArray(reservedW) ? reservedW[i] || 0 : reservedW);
  const room = phaseW.map((w, i) => limitW - CONTROL_RESERVE_W - reserved(i) - Math.max(0, w));
  const on = spec.set || room.map((_, i) => i);
  return phaseCount(spec, limitW) * Math.min(...on.map((i) => room[i]));
};

const phaseCutW = ({ phaseOverW, spec = {} }) => {
  const on = spec.set || phaseOverW.map((_, i) => i);
  const over = Math.max(0, ...on.map((i) => phaseOverW[i]));
  return over > 0 ? over * (spec.n || PHASES) : 0;
};

const phasesOverlap = (a = {}, b = {}) => !a.set || !b.set || a.set.some((i) => b.set.includes(i));

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
