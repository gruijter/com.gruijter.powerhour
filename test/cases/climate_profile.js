'use strict';

const assert = require('assert');
const CP = require('../../lib/ClimateProfile');
const B = require('../../lib/Budget');

// ERA5 2014-2023 summaries (ClimateProfile.summarize) of De Bilt and Melbourne.
const debilt = {
  hdd: [253.3, 216.9, 184.5, 100.9, 31.6, 0.6, 0, 0, 3.8, 40, 148.7, 215.9],
  hddHouse: [284.2, 244.8, 215.2, 127, 47.6, 2, 0, 0.4, 8.7, 59.2, 177.5, 246.8],
  hddCop: [70.6, 60.9, 48.6, 25.3, 7.5, 0.1, 0, 0, 0.9, 9.6, 38.7, 59.3],
  hddWarm: [133.5, 123.6, 153.3, 97.9, 31.6, 0.6, 0, 0, 3.8, 40, 121.6, 121.8],
  hddWarmCop: [34.9, 32, 39.2, 24.4, 7.5, 0.1, 0, 0, 0.9, 9.6, 30.9, 31.1],
  cdd: [0, 0, 0, 0.1, 4.9, 23.5, 36.6, 36.5, 10.1, 0.5, 0, 0],
};
const melbourne = {
  hdd: [0, 0, 0.1, 2.7, 31.2, 75.7, 91.2, 77.2, 37.3, 9.5, 3.7, 0.3],
  hddHouse: [0, 0, 0.4, 7.9, 50.9, 103.9, 121.5, 105.6, 58.6, 22.2, 8.5, 1],
  hddCop: [0, 0, 0, 0.6, 7.3, 18.1, 21.9, 18.5, 8.7, 2.2, 0.8, 0.1],
  hddWarm: [0, 0, 0.1, 2.7, 31.2, 75.7, 91.2, 77.2, 37.3, 9.5, 3.7, 0.3],
  hddWarmCop: [0, 0, 0, 0.6, 7.3, 18.1, 21.9, 18.5, 8.7, 2.2, 0.8, 0.1],
  cdd: [93.6, 65.5, 44.2, 9.6, 0.2, 0, 0, 0, 1.3, 8.8, 28.2, 52.3],
};
// NEDU E1A and G1A (lib/Budget.js el_nl_2023, gas_nl_2023) per month.
const e1a = [11.7, 9.7, 9.2, 7.1, 6.2, 5.5, 5.5, 6.1, 6.9, 9.2, 10.6, 12.3];
const g1a = [18.4, 15.7, 13.2, 7.2, 2.9, 1.6, 1.4, 1.4, 2.0, 6.8, 12.2, 17.2];
const maxDiff = (p, ref) => Math.max(...p.map((v, i) => Math.abs(v * 100 - ref[i])));
const sum = (p) => p.reduce((a, v) => a + v, 0);

const el = CP.profile({
  kind: 'electricity', climate: debilt, lat: 52.1, heating: 'none',
});
assert.ok(Math.abs(sum(el) - 1) < 1e-9, 'shares sum to 1');
assert.ok(maxDiff(el, e1a) < 0.6, `household vs NEDU E1A ${maxDiff(el, e1a).toFixed(2)} pp`);
const gas = CP.profile({
  kind: 'gas', climate: debilt, lat: 52.1, heating: 'boiler',
});
assert.ok(maxDiff(gas, g1a) < 1.8, `gas boiler vs NEDU G1A ${maxDiff(gas, g1a).toFixed(2)} pp`);

const hp = CP.profile({
  kind: 'electricity', climate: debilt, lat: 52.1, heating: 'heat_pump',
});
const direct = CP.profile({
  kind: 'electricity', climate: debilt, lat: 52.1, heating: 'electric',
});
assert.ok(hp[0] > el[0] && direct[0] > hp[0], 'more winter share: household < heat pump < direct electric');
const hybridGas = CP.profile({
  kind: 'gas', climate: debilt, lat: 52.1, heating: 'hybrid',
});
assert.ok(hybridGas[0] > gas[0] && hybridGas[3] < gas[3], 'hybrid: gas on the coldest days only');
const ac = CP.profile({
  kind: 'electricity', climate: debilt, lat: 52.1, heating: 'none', cooling: true,
});
assert.ok(ac[6] > el[6], 'air conditioning raises July');

// Southern hemisphere: winter in July.
const mGas = CP.profile({
  kind: 'gas', climate: melbourne, lat: -37.8, heating: 'boiler',
});
assert.strictEqual(mGas.indexOf(Math.max(...mGas)), 6, 'Melbourne gas peaks in July');
const mAc = CP.profile({
  kind: 'electricity', climate: melbourne, lat: -37.8, heating: 'none', cooling: true,
});
assert.strictEqual(mAc.indexOf(Math.max(...mAc)), 0, 'Melbourne with AC peaks in January');

assert.strictEqual(CP.profile({ kind: 'gas', climate: null, lat: 52 }), null);
assert.deepStrictEqual(CP.pvProfile([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).map((v) => Math.round(v * 1200)), new Array(12).fill(100));
assert.strictEqual(CP.pvProfile([1, 2]), null);

// Budget: local profile, and the fixed one until it is computed.
const date = new Date('2026-07-01T12:00:00Z');
const o = {
  distribution: 'local', budget: '1200', timeZone: 'Europe/Amsterdam', date,
};
assert.strictEqual(B.isActive('local', '1200'), true);
assert.strictEqual(B.getBudgetsToDate({ ...o }), null, 'no profile, no fallback');
const fixed = B.getBudgetsToDate({ ...o, distribution: 'gas_nl_2023' });
assert.deepStrictEqual(B.getBudgetsToDate({ ...o, fallback: 'gas_nl_2023' }), fixed, 'fallback until computed');
const local = B.getBudgetsToDate({ ...o, profile: gas });
assert.ok(Math.abs(local.yearToDate - 1200 * sum(gas.slice(0, 6)) - 1200 * (gas[6] / 31)) < 0.5, `year to date ${local.yearToDate}`);
assert.deepStrictEqual(B.localKind('gas'), { kind: 'gas', fallback: 'gas_nl_2023' });
assert.strictEqual(B.localKind('water'), null);
