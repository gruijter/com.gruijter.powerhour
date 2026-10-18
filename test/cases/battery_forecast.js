/* eslint-disable no-console */

'use strict';

// Scenarios for lib/strategies/RoiStrategy.js with a per-slot net forecast. Run: node test/cases/battery_forecast.js

const assert = require('assert');
const { getStrategy, getGroupStrategy } = require('../../lib/strategies/RoiStrategy');

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

// One day in 15-minute slots from 00:00. hour(i) = slot hour.
const N = 96;
const hour = (i) => Math.floor(i / 4);
const speeds = {
  chargeSpeeds: [{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }],
  dischargeSpeeds: [{ power: 1700, eff: 0.92 }, { power: 800, eff: 0.96 }],
};
const base = {
  priceInterval: 15, minPriceDelta: 0.04, batCapacity: 5, startMinute: 0, ...speeds,
};
// Summer: 3 kW surplus 10-16 h, 400 W home use otherwise, 200 W at night.
const summerNet = Array.from({ length: N }, (_, i) => {
  const h = hour(i);
  if (h >= 10 && h < 16) return { surplusW: 3000, deficitW: 0 };
  if (h < 7) return { surplusW: 0, deficitW: 200 };
  return { surplusW: 0, deficitW: 400 };
}).map((n) => ({ ...n, usableSurplusW: n.surplusW, usableDeficitW: n.deficitW }));
const flat = (v) => new Array(N).fill(v);
const sumKwh = (s, pred) => Object.values(s).reduce((a, x, i) => (pred(x, i) ? a + (x.power * x.duration) / 60000 : a), 0);

test('fixed prices, low export: store midday solar, use it in the evening', () => {
  const s = getStrategy({
    ...base, prices: flat(0.30), exportPrices: flat(0.05), soc: 0, net: summerNet,
  });
  const charged = sumKwh(s, (x, i) => x.power > 0 && hour(i) >= 10 && hour(i) < 16);
  assert.ok(charged > 4, `charged ${charged.toFixed(2)} kWh from solar`);
  assert.ok(Object.values(s).filter((x, i) => hour(i) >= 10 && hour(i) < 16 && x.power > 0).every((x) => x.block === 'zero'));
  assert.ok(Object.values(s).every((x) => x.block !== 'charge'), 'no grid charging');
  assert.ok(sumKwh(s, (x, i) => x.power < 0 && hour(i) >= 16) < -1, 'discharges after 16 h');
});

test('self-consumption: no grid charge even with a cheap night', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) < 6 ? 0.05 : 0.40));
  const s = getStrategy({
    ...base, prices, exportPrices: prices.map((p) => p - 0.1), soc: 0, net: summerNet, allowGridCharge: false, allowExport: false,
  });
  assert.ok(Object.values(s).every((x) => x.block !== 'charge' && x.block !== 'discharge'));
  const smart = getStrategy({
    ...base, prices, exportPrices: prices.map((p) => p - 0.1), soc: 0, net: summerNet,
  });
  assert.ok(Object.values(smart).some((x, i) => x.block === 'charge' && hour(i) < 6), 'smart charges at night');
});

test('low-power threshold: no discharging into a 200 W night load', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) >= 18 && hour(i) < 21 ? 0.45 : 0.30));
  const net = summerNet.map((n) => ({ ...n, usableDeficitW: n.deficitW < 300 ? 0 : n.deficitW }));
  const s = getStrategy({
    ...base, prices, exportPrices: flat(0.05), soc: 80, net, allowExport: false,
  });
  assert.ok(Object.values(s).every((x, i) => !(hour(i) < 7 && x.power < 0)), 'no night discharge');
  // Below the threshold the charge is kept: save.
  assert.ok(Object.values(s).filter((x, i) => hour(i) < 7).every((x) => x.block === 'hold'));
});

test('peak: keeps energy for a load above the limit', () => {
  const net = Array.from({ length: N }, (_, i) => {
    const d = hour(i) === 18 ? 6000 : 500;
    return {
      surplusW: 0, deficitW: d, usableSurplusW: 0, usableDeficitW: d, limitW: 4000, penaltyPerKw: 5,
    };
  });
  const s = getStrategy({
    ...base, prices: flat(0.30), exportPrices: flat(0.29), soc: 60, net, peakWindowMin: 15,
  });
  const at18 = sumKwh(s, (x, i) => hour(i) === 18);
  assert.ok(at18 < -1.4, `discharges ${at18.toFixed(2)} kWh at 18 h`);
});

test('no net: same blocks as before (home use 300 W)', () => {
  const s = getStrategy({
    ...base, prices: flat(0.30), exportPrices: flat(0.29), soc: 50,
  });
  assert.strictEqual(Object.keys(s).length, N);
});

test('48 h of 15-min slots with net and peak: fast enough', () => {
  const prices = Array.from({ length: 192 }, (_, i) => 0.2 + 0.15 * Math.sin(i / 8));
  const net = Array.from({ length: 192 }, (_, i) => summerNet[i % N]).map((n) => ({ ...n, limitW: 5000, penaltyPerKw: 4 }));
  const t = Date.now();
  getStrategy({
    ...base, prices, exportPrices: prices.map((p) => p - 0.12), soc: 40, net,
  });
  const ms = Date.now() - t;
  console.log(`     ${ms} ms`);
  assert.ok(ms < 1500);
});

const bat = (soc, cap, cP, cE, dP, dE) => ({
  soc, batCapacity: cap, chargeSpeeds: [{ power: cP, eff: cE }], dischargeSpeeds: [{ power: dP, eff: dE }],
});
const noTrade = (plans) => Object.keys(plans[0]).every((k) => !(plans.some((p) => p[k].power > 0) && plans.some((p) => p[k].power < 0)));

test('group, different SoC: no battery charges while another discharges', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) >= 17 && hour(i) < 21 ? 0.45 : 0.30));
  const plans = getGroupStrategy({
    ...base, prices, exportPrices: flat(0.05), net: summerNet, batteries: [bat(90, 5, 2200, 0.92, 1700, 0.92), bat(10, 5, 2200, 0.92, 1700, 0.92)],
  });
  assert.strictEqual(plans.length, 2);
  assert.ok(noTrade(plans), 'charge and discharge in the same slot');
  assert.ok(sumKwh(plans[0], (x) => x.power < 0) < -1, 'the full battery discharges');
});

test('group, different efficiency: the efficient battery cycles', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) < 5 ? 0.20 : 0.30));
  const plans = getGroupStrategy({
    ...base,
    prices,
    exportPrices: flat(0.29),
    soc: 0,
    net: null,
    homePowerUsage: 800,
    batteries: [bat(0, 5, 2000, 0.97, 2000, 0.97), bat(0, 5, 2000, 0.80, 2000, 0.80)],
  });
  assert.ok(sumKwh(plans[0], (x) => x.power > 0) > 1, 'efficient battery charges');
  assert.ok(sumKwh(plans[1], (x) => x.power > 0) < 0.01, 'lossy battery stays idle');
});

test('group, different max power: a peak above the limit uses both', () => {
  const net = Array.from({ length: N }, (_, i) => {
    const d = hour(i) === 18 ? 7000 : 500;
    return {
      surplusW: 0, deficitW: d, usableSurplusW: 0, usableDeficitW: d, limitW: 4000, penaltyPerKw: 5,
    };
  });
  const plans = getGroupStrategy({
    ...base,
    prices: flat(0.30),
    exportPrices: flat(0.29),
    net,
    batteries: [bat(80, 5, 1000, 0.92, 1000, 0.92), bat(80, 10, 3000, 0.92, 3000, 0.92)],
  });
  const at18 = (p) => sumKwh(p, (x, i) => hour(i) === 18);
  assert.ok(at18(plans[0]) + at18(plans[1]) < -2.5, `group covers the peak (${(at18(plans[0]) + at18(plans[1])).toFixed(2)} kWh)`);
  assert.ok(at18(plans[1]) < at18(plans[0]), 'the larger battery does more');
});

test('group of 2, 48 h of 15-min slots: fast enough', () => {
  const prices = Array.from({ length: 192 }, (_, i) => 0.2 + 0.15 * Math.sin(i / 8));
  const net = Array.from({ length: 192 }, (_, i) => summerNet[i % N]).map((n) => ({ ...n, limitW: 5000, penaltyPerKw: 4 }));
  const t = Date.now();
  getGroupStrategy({
    ...base, prices, exportPrices: prices.map((p) => p - 0.12), net, batteries: [bat(40, 5, 2200, 0.9, 1700, 0.92), bat(70, 10, 3000, 0.95, 3000, 0.95)],
  });
  const ms = Date.now() - t;
  console.log(`     ${ms} ms`);
  assert.ok(ms < 3000);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
