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

const STALE_MS = 48 * 3600 * 1000;
const MAX_SESSIONS = 20;
const MIN_SESSION_KWH = 0.5;
const MIN_SESSIONS = 3;
const NEED_QUANTILE = 0.75;
const MARGIN = 1.2;

const createState = () => ({
  sessions: [],
  session: null,
});

const isActive = ({ reportTm, usedSinceReport, now }) => typeof reportTm !== 'number'
  || (now - reportTm > STALE_MS && !!usedSinceReport);

const startSession = (state, tm, kwhCounter) => ({
  ...state,
  session: typeof kwhCounter === 'number' ? { startTm: tm, startKwh: kwhCounter } : null,
});

const endSession = (state, tm, kwhCounter) => {
  const next = { ...state, session: null, sessions: [...(state.sessions || [])] };
  const s = state.session;
  if (s && typeof kwhCounter === 'number' && kwhCounter - s.startKwh >= MIN_SESSION_KWH) {
    next.sessions.push({ tm, kwh: Math.round((kwhCounter - s.startKwh) * 100) / 100 });
    if (next.sessions.length > MAX_SESSIONS) next.sessions = next.sessions.slice(-MAX_SESSIONS);
  }
  return next;
};

const sessionNeedKwh = (state, defaultKwh, maxKwh) => {
  const kwh = (state.sessions || []).map((s) => s.kwh).sort((a, b) => a - b);
  if (kwh.length < MIN_SESSIONS) return Math.min(maxKwh, defaultKwh);
  const q = kwh[Math.min(kwh.length - 1, Math.floor(NEED_QUANTILE * (kwh.length - 1) + 0.5))];
  return Math.min(maxKwh, q * MARGIN);
};

const remainingKwh = (state, kwhCounter, needKwh) => {
  const s = state.session;
  if (!s || typeof kwhCounter !== 'number') return needKwh;
  return Math.max(0, needKwh - Math.max(0, kwhCounter - s.startKwh));
};

module.exports = {
  createState,
  isActive,
  startSession,
  endSession,
  sessionNeedKwh,
  remainingKwh,
  STALE_MS,
  MIN_SESSIONS,
  MIN_SESSION_KWH,
};
