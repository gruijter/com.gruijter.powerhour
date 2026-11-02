/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/PhaseLearning.js. Run: node test/cases/phase_learning.js

const assert = require('assert');
const P = require('../../lib/strategies/PhaseLearning');

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

test('one device: 1 phase, 3 phases, discharge step', () => {
  assert.strictEqual(P.classify([2150, 30, -40], [{ stepW: 2200 }]), 'l1');
  assert.strictEqual(P.classify([-20, 60, -2250], [{ stepW: -2200 }]), 'l3');
  assert.strictEqual(P.classify([3650, 3700, 3600], [{ stepW: 11000 }]), 'l123');
});

test('one device: another load meanwhile, or a small 3-phase step in noise, is no vote', () => {
  assert.strictEqual(P.classify([2200, 1500, 0], [{ stepW: 2200 }]), null);
  assert.strictEqual(P.classify([0, 0, 0], [{ stepW: 2200 }]), null);
  assert.strictEqual(P.classify([600, 0, 0], [{ stepW: 2200 }]), null, 'partial: the report lagged');
});

test('car starts on L1, a battery on L2 covers it: both fitted', () => {
  const dPhaseW = [3680, -2200, 0];
  assert.strictEqual(P.classify(dPhaseW, [{ stepW: 3680 }, { stepW: -2200, spec: { n: null, set: null } }]), 'l1');
  assert.strictEqual(P.classify(dPhaseW, [{ stepW: -2200 }, { stepW: 3680, spec: { n: 1, set: [0] } }]), 'l2');
});

test('two equal batteries at once on L1 and L2: cannot be told apart', () => {
  assert.strictEqual(P.classify([2200, 2200, 0], [{ stepW: 2200 }, { stepW: 2200, spec: {} }]), null);
  assert.strictEqual(P.classify([2200, 2200, 0], [{ stepW: 2200 }, { stepW: 2200, spec: { n: 1, set: [1] } }]), 'l1', 'the other known');
});

test('votes: learned on a clear majority of at least 5', () => {
  let v = [];
  ['l2', 'l2', 'l2', 'l2'].forEach((id) => {
    v = P.addVote(v, id);
  });
  assert.strictEqual(P.learned(v), null);
  v = P.addVote(v, 'l2');
  assert.strictEqual(P.learned(v), 'l2');
  v = P.addVote(v, 'l1');
  v = P.addVote(v, 'l1');
  assert.strictEqual(P.learned(v), null, '5 of 7');
  for (let i = 0; i < 30; i += 1) v = P.addVote(v, 'l3');
  assert.strictEqual(v.length, 20);
  assert.strictEqual(P.learned(v), 'l3');
  assert.deepStrictEqual(P.toSpec('l2'), { n: 1, set: [1], known: true });
  assert.deepStrictEqual(P.toSpec('l123'), { n: 3, set: [0, 1, 2], known: true });
  assert.strictEqual(P.toSpec('auto'), null);
});

test('spec: setting first, learned only when trusted', () => {
  const votes = Array(6).fill('l3');
  assert.deepStrictEqual(P.specOf('l1', votes), { n: 1, set: [0], known: true });
  assert.deepStrictEqual(P.specOf('auto', votes), {
    n: 1, set: [2], known: true, learned: true,
  });
  assert.strictEqual(P.specOf('auto', votes, false), null);
  assert.deepStrictEqual(P.specOf('l1', votes, false), { n: 1, set: [0], known: true });
});

test('step detector: a ramp is one step, a short level none', () => {
  const d = P.stepDetector(600);
  const t = 1e6;
  assert.strictEqual(d.onPower(0, t), null);
  const step = d.onPower(400, t + 30000);
  assert.deepStrictEqual(step, { atMs: t + 30000, fromW: 0 });
  d.onPower(1200, t + 32000);
  d.onPower(2200, t + 34000);
  d.onPower(2180, t + 40000);
  assert.strictEqual(d.settled(step, t + 50000), null, 'not held long enough');
  assert.deepStrictEqual(d.settled(step, t + 60000), { stepW: 2200, sinceMs: t + 34000 });
  assert.strictEqual(d.onPower(0, t + 50000), null, 'level held < 25 s before');
});

test('window: time-weighted mean and spread of held reports', () => {
  const h = [{ tm: 0, w: 0 }, { tm: 10, w: 100 }, { tm: 20, w: 100 }];
  assert.deepStrictEqual(P.windowOf(h, 5, 25), { mean: 75, spread: 100 });
  assert.deepStrictEqual(P.windowOf(h, 12, 30), { mean: 100, spread: 0 });
  assert.strictEqual(P.windowOf(h, -5, 5), null);
});

// Learner with a fake app: phase readings every second, a battery on L2 and a car on L1.
test('learner: battery and car learn their phases from steps, also when they step together', () => {
  let now = 1e9;
  const timers = [];
  const readings = [];
  const grid = {
    getImportHeadroomW: () => 0,
    getPhasePowerW: () => [1, 1, 1],
    getPhaseMeanW: (from, to) => {
      const list = readings.filter((r) => r.tm >= from && r.tm <= to);
      return list.length ? [0, 1, 2].map((i) => list.reduce((a, r) => a + r.w[i], 0) / list.length) : null;
    },
  };
  const homey = {
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
    drivers: { getDriver: (id) => (id === 'grid' ? { getDevices: () => [grid] } : null) },
  };
  const device = (name) => {
    const store = {};
    return {
      homey,
      getStoreValue: (k) => store[k],
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      log: () => {},
      error: (...a) => console.log(name, ...a),
      fusePhases() {
        return (this.learner && this.learner.spec()) || { n: null, set: null };
      },
    };
  };
  const bat = device('bat');
  bat.learner = new P.Learner(bat, { minStepW: 600 });
  const car = device('car');
  car.learner = new P.Learner(car, { minStepW: 1000 });
  let batW = 0;
  let carW = 0;
  const tick = () => {
    const noise = (k) => Math.round(Math.sin(now / 7000 + k) * 40);
    readings.push({ tm: now, w: [300 + carW + noise(0), 400 + batW + noise(1), 200 + noise(2)] });
    timers.filter((x) => x.at <= now).forEach((x) => {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    });
    now += 1000;
  };
  const hold = (s) => {
    for (let i = 0; i < s; i += 1) tick();
  };
  bat.learner.onPower(0, now);
  car.learner.onPower(0, now);
  hold(60);
  for (let k = 0; k < 6; k += 1) {
    batW = 2200;
    bat.learner.onPower(batW, now);
    hold(60);
    batW = 0;
    bat.learner.onPower(batW, now);
    hold(60);
  }
  assert.strictEqual(bat.learner.learned(), 'l2', JSON.stringify(bat.getStoreValue('phaseVotes')));
  // The car starts, the battery (now known) covers it 2 s later.
  for (let k = 0; k < 6; k += 1) {
    carW = 3680;
    car.learner.onPower(carW, now);
    hold(2);
    batW = -2200;
    bat.learner.onPower(batW, now);
    hold(60);
    carW = 0;
    car.learner.onPower(carW, now);
    hold(2);
    batW = 0;
    bat.learner.onPower(batW, now);
    hold(60);
  }
  assert.strictEqual(car.learner.learned(), 'l1', JSON.stringify(car.getStoreValue('phaseVotes')));
  assert.strictEqual(bat.learner.learned(), 'l2');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
