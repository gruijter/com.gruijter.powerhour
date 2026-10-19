/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/LoadSpread.js and PriceShift.isNewSlot(). Run: node test/cases/load_spread.js

const assert = require('assert');

let T = Date.UTC(2026, 9, 19, 10, 0, 20); // 20 s after a quarter boundary: in the burst
Date.now = () => T;

const LoadSpread = require('../../lib/helpers/LoadSpread');
const PriceShift = require('../../lib/helpers/PriceShift');

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

const device = () => {
  const timers = [];
  return {
    timers,
    timeZone: 'UTC',
    homey: { setTimeout: (fn, ms) => timers.push({ at: T + ms, fn }), clock: { getTimezone: () => 'UTC' } },
    error: (e) => {
      throw e;
    },
  };
};
const fire = async (d) => {
  for (const t of d.timers.splice(0)) {
    T = Math.max(T, t.at);
    t.fn();
  }
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
};

(async () => {
  await test('deferred in the burst, flags merged, the latest fn', async () => {
    T = Date.UTC(2026, 9, 19, 10, 0, 20);
    const d = device();
    const runs = [];
    await LoadSpread.run(d, 'k', (f) => runs.push(['a', f]), { x: true, y: false });
    await LoadSpread.run(d, 'k', (f) => runs.push(['b', f]), { y: true });
    assert.strictEqual(runs.length, 0);
    await fire(d);
    assert.deepStrictEqual(runs, [['b', { x: true, y: true }]]);
  });

  await test('a call after the burst runs now and drops the deferred one', async () => {
    T = Date.UTC(2026, 9, 19, 10, 0, 20);
    const d = device();
    const runs = [];
    await LoadSpread.run(d, 'k', (f) => runs.push(['old', f]), { x: true });
    T = Date.UTC(2026, 9, 19, 10, 2, 0);
    await LoadSpread.run(d, 'k', (f) => runs.push(['new', f]), { y: true });
    await fire(d);
    assert.deepStrictEqual(runs, [['new', { x: true, y: true }]]);
  });

  await test('isNewSlot', async () => {
    const at = (h, m) => Date.UTC(2026, 9, 19, h, m);
    assert.strictEqual(PriceShift.isNewSlot(at(10, 5), 15, 'UTC', at(10, 14)), false);
    assert.strictEqual(PriceShift.isNewSlot(at(10, 5), 15, 'UTC', at(10, 15)), true);
    assert.strictEqual(PriceShift.isNewSlot(at(10, 5), 60, 'UTC', at(10, 59)), false);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
