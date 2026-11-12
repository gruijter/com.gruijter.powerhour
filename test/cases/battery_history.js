/* eslint-disable no-console */

'use strict';

// Unit cases for the pairing proposal of capacity and max. power from hourly Insights
// (BatteryHistory.propose). Run: node test/cases/battery_history.js

const assert = require('assert');
const BatteryHistory = require('../../lib/helpers/BatteryHistory');

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

const HOUR = 3600 * 1000;
// Hourly points from [soc %, power W] pairs.
const series = (rows) => ({
  soc: rows.map(([soc], i) => ({ t: i * HOUR, v: soc })),
  power: rows.map(([, w], i) => ({ t: i * HOUR, v: w })),
});

// A 5 kWh battery: charges at 2000 W, discharges 1000 W per hour (20%).
const ROWS = [[10, 0], [20, 2000], [60, 2000], [90, 500], [90, -1000], [70, -1000], [50, -1000], [30, -1000], [20, 0], [20, 0]];

test('capacity from the discharge run, power limits rounded up', () => {
  const { soc, power } = series(ROWS);
  const out = BatteryHistory.propose(soc, power);
  // Run 90 -> 20 (70%): half hours around the steps 500/-1000 ... -1000/0 = 3.75 kWh -> 5.4 kWh.
  assert.strictEqual(out.batCapacity, 5.4);
  assert.strictEqual(out.chargePower, 2000);
  assert.strictEqual(out.dischargePower, 1000);
});

test('frozen log: no proposal', () => {
  const { soc, power } = series(ROWS.map(() => [25, 1079]));
  assert.deepStrictEqual(BatteryHistory.propose(soc, power), {});
});

test('no discharge run of 30%: power only', () => {
  const { soc, power } = series([[40, 0], [80, 2100], [80, 0], [70, -800], [60, -800], [60, 0]]);
  const out = BatteryHistory.propose(soc, power);
  assert.strictEqual(out.batCapacity, undefined);
  assert.strictEqual(out.chargePower, 2100);
  assert.strictEqual(out.dischargePower, 800);
});

test('no history: no proposal', () => {
  assert.deepStrictEqual(BatteryHistory.propose([], []), {});
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
