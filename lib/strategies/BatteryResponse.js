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

// Learns how fast a battery does a new setpoint, for any battery: from a setpoint step of our own
// to the first report at 90 % of it, from standstill and while running. Pure: the device passes
// writes and reports and stores the state (a few bytes). Resolution: the battery's report interval.

const MIN_STEP_W = 200;
const STANDSTILL_W = 50;
const REACHED = 0.9;
// Not reached by then: a limit of the battery (full, empty, its own), no sample.
const MAX_WAIT_MS = 3 * 60 * 1000;
// Each new sample weighs this much in the average.
const WEIGHT = 0.2;

const createState = () => ({ standstill: { ms: null, n: 0 }, running: { ms: null, n: 0 }, step: null });

/**
 * A setpoint written by control. A further write the same way keeps the step's start (a start
 * from standstill is often written in parts); the other way, or a small step, ends it.
 *
 * @param {object} state
 * @param {{now:number, setW:number, actW:number, idleMs:number, standstill:boolean}} w - actW:
 *   measured power at the write; idleMs: how long it stood still (null: running); standstill: when
 *   actW is not the battery's own power (the grid meter)
 * @returns {object} state
 */
const onWrite = (state, {
  now, setW, actW, idleMs = null, standstill = null,
}) => {
  const s = { ...state };
  const { step } = s;
  if (step && Math.sign(setW - step.fromW) === Math.sign(step.toW - step.fromW) && Math.abs(setW - step.fromW) >= MIN_STEP_W) {
    s.step = { ...step, toW: setW };
    return s;
  }
  s.step = Number.isFinite(actW) && Math.abs(setW - actW) >= MIN_STEP_W ? {
    fromW: actW, toW: setW, tm: now, standstill: typeof standstill === 'boolean' ? standstill : Math.abs(actW) < STANDSTILL_W, idleMs,
  } : null;
  return s;
};

/**
 * A measured power from the battery.
 *
 * @param {object} state
 * @param {{now:number, actW:number}} r
 * @returns {{state: object, sample: {kind:string, ms:number, fromW:number, toW:number, idleMs:number|null}|null}}
 */
const onReport = (state, { now, actW }) => {
  const { step } = state;
  if (!step || !Number.isFinite(actW)) return { state, sample: null };
  if (now - step.tm > MAX_WAIT_MS) return { state: { ...state, step: null }, sample: null };
  if ((actW - step.fromW) / (step.toW - step.fromW) < REACHED) return { state, sample: null };
  const kind = step.standstill ? 'standstill' : 'running';
  const ms = now - step.tm;
  const prev = state[kind];
  const avg = prev.ms === null ? ms : ((1 - WEIGHT) * prev.ms) + (WEIGHT * ms);
  return {
    state: { ...state, [kind]: { ms: Math.round(avg), n: prev.n + 1 }, step: null },
    sample: {
      kind, ms, fromW: step.fromW, toW: step.toW, idleMs: step.standstill ? step.idleMs : null,
    },
  };
};

const describe = (state) => ['standstill', 'running']
  .map((k) => `${k} ${state[k].ms === null ? '-' : `${(state[k].ms / 1000).toFixed(1)} s`} (n ${state[k].n})`)
  .join(', ');

module.exports = {
  createState, onWrite, onReport, describe,
};
