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

const GridConnection = require('../helpers/GridConnection');

const BEFORE_MS = 25 * 1000;
const AFTER_MS = 25 * 1000;
const GAP_MS = 10 * 1000;
const RAMP_MS = 10 * 1000;
const HISTORY_MS = 120 * 1000;
const BAND_W = 150;
const OTHER_STEP_W = 200;
const MAX_UNKNOWN = 3;
const HYPOTHESES = {
  l1: [1, 0, 0], l2: [0, 1, 0], l3: [0, 0, 1], l123: [1 / 3, 1 / 3, 1 / 3],
};
const MAX_ERR = 0.1;
const MIN_GAP = 0.25;
const MAX_VOTES = 20;
const MIN_VOTES = 5;
const MAJORITY = 0.8;

const shares = (spec) => {
  if (!spec || !Array.isArray(spec.set) || !spec.n) return null;
  return [0, 1, 2].map((i) => (spec.set.includes(i) ? 1 / spec.n : 0));
};

const classify = (dPhaseW, steps) => {
  if (!dPhaseW || !steps.length || !steps[0].stepW) return null;
  const known = steps.map((st, k) => (k === 0 ? null : shares(st.spec)));
  const unknown = known.map((e, k) => (e ? -1 : k)).filter((k) => k >= 0);
  if (unknown.length > MAX_UNKNOWN) return null;
  const scale = Math.abs(steps[0].stepW);
  const ids = Object.keys(HYPOTHESES);
  const best = {};
  const total = ids.length ** unknown.length;
  for (let c = 0; c < total; c += 1) {
    const pick = known.slice();
    let rest = c;
    unknown.forEach((k) => {
      pick[k] = HYPOTHESES[ids[rest % ids.length]];
      rest = Math.floor(rest / ids.length);
    });
    const err = [0, 1, 2].reduce((a, i) => {
      const fit = steps.reduce((w, st, k) => w + (st.stepW * pick[k][i]), 0);
      return a + (((dPhaseW[i] - fit) / scale) ** 2);
    }, 0);
    const id = ids[c % ids.length];
    if (!(id in best) || err < best[id]) best[id] = err;
  }
  const sorted = Object.entries(best).sort((a, b) => a[1] - b[1]);
  return sorted[0][1] <= MAX_ERR && sorted[1][1] - sorted[0][1] >= MIN_GAP ? sorted[0][0] : null;
};

const addVote = (votes, id) => [...(Array.isArray(votes) ? votes : []), id].slice(-MAX_VOTES);

const learned = (votes) => {
  if (!Array.isArray(votes) || votes.length < MIN_VOTES) return null;
  const count = {};
  votes.forEach((v) => {
    count[v] = (count[v] || 0) + 1;
  });
  const [id, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return n >= MAJORITY * votes.length ? id : null;
};

const toSpec = (id) => {
  if (id === 'l123') return { n: 3, set: [0, 1, 2], known: true };
  const i = ['l1', 'l2', 'l3'].indexOf(id);
  return i < 0 ? null : { n: 1, set: [i], known: true };
};

const lastAtOrBefore = (history, tm) => {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].tm <= tm) return i;
  return -1;
};

const windowOf = (history, from, to) => {
  const startIdx = lastAtOrBefore(history, from);
  if (startIdx < 0) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = startIdx; i < history.length && history[i].tm < to; i += 1) {
    const a = Math.max(from, history[i].tm);
    const b = i + 1 < history.length ? Math.min(to, history[i + 1].tm) : to;
    sum += history[i].w * (b - a);
    min = Math.min(min, history[i].w);
    max = Math.max(max, history[i].w);
  }
  return { mean: sum / (to - from), spread: max - min };
};

const stepDetector = (minStepW) => {
  let level = null;
  return {
    onPower(w, now) {
      if (level && Math.abs(w - level.w) <= BAND_W) return null;
      const prev = level;
      level = { w, since: now };
      return prev && now - prev.since >= BEFORE_MS ? { atMs: now, fromW: prev.w } : null;
    },
    settled(step, now) {
      if (!level || level.since - step.atMs > RAMP_MS || now - level.since < AFTER_MS) return null;
      const stepW = level.w - step.fromW;
      return Math.abs(stepW) >= minStepW ? { stepW, sinceMs: level.since } : null;
    },
  };
};

const registries = new WeakMap();
const registryOf = (homey) => {
  if (!registries.has(homey)) registries.set(homey, new Set());
  return registries.get(homey);
};

class Learner {

  constructor(device, { minStepW }) {
    this.device = device;
    this.detector = stepDetector(minStepW);
    this.history = [];
    registryOf(device.homey).add(this);
  }

  onPower(w, now = Date.now()) {
    if (typeof w !== 'number') return;
    this.history.push({ tm: now, w });
    const keep = lastAtOrBefore(this.history, now - HISTORY_MS);
    if (keep > 0) this.history.splice(0, keep);
    const step = this.detector.onPower(w, now);
    if (!step) return;
    const grid = GridConnection.gridDevice(this.device.homey);
    if (!grid || typeof grid.getPhaseMeanW !== 'function' || !grid.getPhasePowerW(now)) return;
    this.device.homey.setTimeout(() => {
      try {
        this.evaluate(step, grid, Date.now());
      } catch (err) {
        this.device.error('[Phase]', err);
      }
    }, RAMP_MS + AFTER_MS + 1000);
  }

  evaluate(step, grid, now) {
    const done = !this.device.isDestroyed && this.detector.settled(step, now);
    if (!done) return;
    const before = [step.atMs - BEFORE_MS, step.atMs - GAP_MS];
    const after = [done.sinceMs + GAP_MS, done.sinceMs + AFTER_MS];
    const steps = [{ stepW: done.stepW }];
    const registry = registryOf(this.device.homey);
    for (const other of registry) {
      if (other.device.isDestroyed) registry.delete(other);
      else if (other !== this && other.history.length) {
        const b = windowOf(other.history, ...before);
        const a = windowOf(other.history, ...after);
        if (!b || !a || b.spread > BAND_W || a.spread > BAND_W) return;
        if (Math.abs(a.mean - b.mean) >= OTHER_STEP_W) steps.push({ stepW: a.mean - b.mean, spec: other.device.fusePhases() });
      }
    }
    const pb = grid.getPhaseMeanW(...before);
    const pa = grid.getPhaseMeanW(...after);
    if (!pb || !pa) return;
    const id = classify(pa.map((w, i) => w - pb[i]), steps);
    if (!id) return;
    const was = this.learned();
    const votes = addVote(this.device.getStoreValue('phaseVotes'), id);
    this.device.setStoreValue('phaseVotes', votes).catch(this.device.error);
    const is = learned(votes);
    if (is !== was) this.device.log(`[Phase] ${is ? `learned: ${is}` : 'no longer clear'} (${votes.join(',')})`);
  }

  learned() {
    return learned(this.device.getStoreValue('phaseVotes'));
  }

}

const specOf = (setting, votes, trustLearned = true) => {
  const set = toSpec(setting);
  if (set || !trustLearned) return set;
  const spec = toSpec(learned(votes));
  return spec && { ...spec, learned: true };
};

module.exports = {
  specOf,
  classify,
  addVote,
  learned,
  toSpec,
  windowOf,
  stepDetector,
  Learner,
  BEFORE_MS,
  AFTER_MS,
  GAP_MS,
  RAMP_MS,
};
