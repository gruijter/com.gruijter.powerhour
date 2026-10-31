/* eslint-disable no-console */

'use strict';

// Unit cases for MeterHelpers.cumulativeReading(): the guard on a battery's cumulative source
// meters (kWh charged/discharged). Run: node test/cases/source_meter_guard.js

const assert = require('assert');
const MeterHelpers = require('../../lib/helpers/MeterHelpers');

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

const MIN = 60 * 1000;

test('rising values are used', () => {
  let r = MeterHelpers.cumulativeReading(undefined, 10, 0);
  assert.deepStrictEqual([r.use, r.rebase, r.state.value], [true, false, 10]);
  r = MeterHelpers.cumulativeReading(r.state, 10.1, MIN);
  assert.deepStrictEqual([r.use, r.rebase, r.state.value], [true, false, 10.1]);
});

test('null and NaN are skipped, the state stays', () => {
  const state = { value: 56.6, lowerSince: null };
  for (const v of [null, undefined, NaN, '56']) {
    const r = MeterHelpers.cumulativeReading(state, v, 0);
    assert.strictEqual(r.use, false);
    assert.strictEqual(r.state, state);
  }
});

test('no stored value yet: the first value is used', () => {
  const r = MeterHelpers.cumulativeReading({ value: null }, 3, 0);
  assert.deepStrictEqual([r.use, r.state.value], [true, 3]);
});

test('a brief dip and its recovery cost no money', () => {
  // Net meter = discharged - charged; the dip would be paid at import, the recovery at export.
  let money = {
    day: 0, month: 0, year: 0, meterValue: 56.6 - 59.2,
  };
  let dis = { value: 56.6, lowerSince: null };
  const charged = 59.2;
  const steps = [[52.2, 0.30], [56.6, 0.05]]; // [discharged, tariff]
  steps.forEach(([v, tariff], i) => {
    const r = MeterHelpers.cumulativeReading(dis, v, i * MIN);
    dis = r.state;
    if (r.use) money = MeterHelpers.calculateMoney(money, { meterValue: dis.value - charged }, tariff);
  });
  assert.strictEqual(Math.round(money.day * 100) / 100, 0);
});

test('without the guard the same dip loses money', () => {
  let money = {
    day: 0, month: 0, year: 0, meterValue: 56.6 - 59.2,
  };
  money = MeterHelpers.calculateMoney(money, { meterValue: 52.2 - 59.2 }, 0.30);
  money = MeterHelpers.calculateMoney(money, { meterValue: 56.6 - 59.2 }, 0.05);
  assert.ok(money.day < -1);
});

test('a lower value that lasts 15 min is a reset: rebase', () => {
  let r = MeterHelpers.cumulativeReading({ value: 56.6, lowerSince: null }, 0.1, 0);
  assert.deepStrictEqual([r.use, r.state.value, r.state.lowerSince], [false, 56.6, 0]);
  r = MeterHelpers.cumulativeReading(r.state, 0.2, 10 * MIN);
  assert.deepStrictEqual([r.use, r.state.lowerSince], [false, 0]);
  r = MeterHelpers.cumulativeReading(r.state, 0.3, 15 * MIN);
  assert.deepStrictEqual([r.use, r.rebase, r.state.value, r.state.lowerSince], [true, true, 0.3, null]);
  r = MeterHelpers.cumulativeReading(r.state, 0.4, 16 * MIN);
  assert.deepStrictEqual([r.use, r.rebase], [true, false]);
});

test('a recovery before 15 min clears the pending reset', () => {
  let r = MeterHelpers.cumulativeReading({ value: 56.6, lowerSince: null }, 50, 0);
  r = MeterHelpers.cumulativeReading(r.state, 56.7, 5 * MIN);
  assert.deepStrictEqual([r.use, r.state.lowerSince], [true, null]);
  r = MeterHelpers.cumulativeReading(r.state, 50, 30 * MIN);
  assert.deepStrictEqual([r.use, r.state.lowerSince], [false, 30 * MIN]);
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
