/* eslint-disable no-console */

'use strict';

// lib/strategies/LightPlanner.js against the LP (PrecisePlanner). Run: node --expose-gc test/cases/battery_light.js

const assert = require('assert');
const lp = require('../../lib/strategies/PrecisePlanner');
const light = require('../../lib/strategies/LightPlanner');

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

const N = 192;
const hour = (i) => Math.floor(i / 4) % 24;
const speeds = {
  chargeSpeeds: [{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }],
  dischargeSpeeds: [{ power: 1700, eff: 0.92 }, { power: 800, eff: 0.96 }],
};
const base = {
  priceInterval: 15, minPriceDelta: 0.04, batCapacity: 5, startMinute: 0, ...speeds,
};
const summerNet = Array.from({ length: N }, (_, i) => {
  const h = hour(i);
  if (h >= 10 && h < 16) return { surplusW: 3000, deficitW: 0 };
  if (h < 7) return { surplusW: 0, deficitW: 200 };
  if (h >= 17 && h < 22) return { surplusW: 0, deficitW: 900 };
  return { surplusW: 0, deficitW: 400 };
}).map((n) => ({ ...n, usableSurplusW: n.surplusW, usableDeficitW: n.deficitW }));
const winterNet = summerNet.map((n, i) => ({
  surplusW: 0, deficitW: 300 + (hour(i) >= 17 && hour(i) < 22 ? 1500 : 0), usableSurplusW: 0, usableDeficitW: 300 + (hour(i) >= 17 && hour(i) < 22 ? 1500 : 0),
}));
const dayPrices = Array.from({ length: N }, (_, i) => {
  const h = hour(i);
  return 0.25 + (h >= 17 && h < 21 ? 0.15 : 0) - (h >= 1 && h < 5 ? 0.08 : 0) - (h >= 11 && h < 15 ? 0.1 : 0) + (0.01 * Math.sin(i));
});

// The same yardstick for both plans: grid cost over the horizon minus the stored energy's value.
const evaluate = (plans, o) => {
  const caps = o.batteries ? o.batteries.map((b) => b.batCapacity) : [o.batCapacity];
  const { prices } = o;
  const exp = o.exportPrices || prices;
  let cost = 0;
  for (let t = 0; t < prices.length; t += 1) {
    const n = o.net[t];
    const batKwh = plans.reduce((a, p) => a + ((p[t].power * (p[t].duration || 0)) / 60000), 0);
    const grid = ((n.deficitW - n.surplusW) * 0.25) / 1000 + batKwh;
    cost += grid > 0 ? grid * prices[t] : grid * exp[t];
  }
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const endKwh = plans.reduce((a, p, b) => a + ((p[prices.length - 1].soc / 100) * caps[b]), 0);
  return cost - (endKwh * mean * 0.92);
};

const compare = (name, o, tolerance) => test(name, () => {
  const group = !!o.batteries;
  const t0 = Date.now();
  const a = group ? lp.planEach(o) : [lp.plan(o)];
  const t1 = Date.now();
  const b = group ? light.planEach(o) : [light.plan(o)];
  const t2 = Date.now();
  const costLp = evaluate(a, o);
  const costLight = evaluate(b, o);
  const noBattery = evaluate([], { ...o, batteries: [] });
  const saveLp = noBattery - costLp;
  const saveLight = noBattery - costLight;
  console.log(`     saving LP ${saveLp.toFixed(3)} (${t1 - t0} ms), light ${saveLight.toFixed(3)} (${t2 - t1} ms)`);
  b.forEach((p) => Object.values(p).forEach((x) => assert.ok(x.soc >= 0 && x.soc <= 100, `soc ${x.soc}`)));
  assert.ok(saveLight >= saveLp * (1 - tolerance) - 0.01, `light saves ${saveLight.toFixed(3)} vs LP ${saveLp.toFixed(3)}`);
});

compare('summer, low export: store solar', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map(() => 0.05), soc: 20, net: summerNet,
}, 0.05);
compare('winter, cheap night: grid arbitrage', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), soc: 50, net: winterNet,
}, 0.05);
compare('self-consumption', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), soc: 50, net: summerNet, allowGridCharge: false, allowExport: false,
}, 0.05);
compare('import limit with penalty', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), soc: 30, net: winterNet.map((n) => ({ ...n, limitW: 1000, penaltyPerKw: 5 })), peakWindowMin: 15,
}, 0.1);
const bat = (soc, cap, cP, cE, dP, dE) => ({
  soc, batCapacity: cap, chargeSpeeds: [{ power: cP, eff: cE }], dischargeSpeeds: [{ power: dP, eff: dE }],
});
compare('group of 2, alike', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), net: summerNet, batteries: [bat(40, 5, 2200, 0.92, 1700, 0.92), bat(70, 5, 2200, 0.92, 1700, 0.92)],
}, 0.05);
compare('group of 2, different', {
  ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), net: winterNet, batteries: [bat(40, 5, 2200, 0.9, 1700, 0.92), bat(70, 10, 3000, 0.95, 3000, 0.95)],
}, 0.15);

test('memory and time: 48 h, group of 2', () => {
  const o = {
    ...base, prices: dayPrices, exportPrices: dayPrices.map((p) => p - 0.12), net: winterNet, batteries: [bat(40, 5, 2200, 0.9, 1700, 0.92), bat(70, 10, 3000, 0.95, 3000, 0.95)],
  };
  if (global.gc) global.gc();
  const before = process.memoryUsage();
  const t = Date.now();
  light.planEach(o);
  const ms = Date.now() - t;
  const after = process.memoryUsage();
  const mb = (k) => ((after[k] - before[k]) / 1e6).toFixed(2);
  console.log(`     ${ms} ms, heap +${mb('heapUsed')} MB, arrayBuffers +${mb('arrayBuffers')} MB`);
  assert.ok(ms < 500);
});

test('efficiency curve: mix of speeds', () => {
  const eff = light.effCurve([{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }]);
  assert.strictEqual(eff(500), 0.95);
  assert.ok(eff(1600) < 0.95 && eff(1600) > 0.9);
  assert.strictEqual(eff(3000), 0);
});

// Self-consumption (minimizeGrid): net metering (export = import), empty battery. Without it no
// cycle pays off (or barely); with it all it can of the surplus is stored and covers the evening,
// the dearest hours first.
test('minimizeGrid: least import and export first, then the cheapest way', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) >= 19 && hour(i) < 21 ? 0.4 : 0.25));
  const o = {
    ...base, prices, exportPrices: prices, soc: 0, net: summerNet, allowGridCharge: false, allowExport: false,
  };
  const gridKwh = (strat) => Object.keys(strat).reduce((a, k) => {
    const n = summerNet[k];
    const batW = strat[k].power;
    return a + (Math.abs((n.deficitW - n.surplusW) + batW) * 0.25) / 1000;
  }, 0);
  for (const planner of [lp, light]) {
    const plain = planner.plan(o);
    const min = planner.plan({ ...o, minimizeGrid: true });
    console.log(`     grid exchange ${gridKwh(min).toFixed(1)} kWh, without minimizeGrid ${gridKwh(plain).toFixed(1)} kWh`);
    assert.ok(gridKwh(min) < gridKwh(plain) - 1, `less grid exchange (${gridKwh(min).toFixed(1)} vs ${gridKwh(plain).toFixed(1)})`);
    assert.ok(Object.values(min).every((v) => v.block !== 'charge' && v.block !== 'discharge'), 'no grid charge or export');
    assert.ok(Object.values(min).every((v, k) => v.price === prices[k]), 'real prices in the result');
    // The first evening: the dear hours 19-21 are covered.
    const evening = Object.keys(min).filter((k) => k < 96 && hour(k) >= 19 && hour(k) < 21);
    assert.ok(evening.every((k) => min[k].power < 0), 'the dearest hours are covered');
  }
});

// Wear: a cycle must pay losses, wear and the minimum profit (smart). Spread 0.18 (0.15 -> 0.33).
test('wear: smart trades only when the spread pays losses, wear and minimum profit', () => {
  const prices = Array.from({ length: N }, (_, i) => (hour(i) >= 18 && hour(i) < 21 ? 0.33 : 0.15));
  const o = {
    ...base, prices, soc: 0, net: winterNet, minPriceDelta: 0.02,
  };
  const cycled = (strat) => Object.values(strat).some((v) => v.power > 0);
  for (const planner of [lp, light]) {
    assert.ok(cycled(planner.plan(o)), 'without wear it cycles');
    assert.ok(cycled(planner.plan({ ...o, wearCost: 0.05 })), 'small wear: still cycles');
    assert.ok(!cycled(planner.plan({ ...o, wearCost: 0.15 })), 'wear above the spread: idle');
    assert.ok(!cycled(planner.plan({ ...o, wearCost: 0.08, minPriceDelta: 0.08 })), 'wear + minimum profit above the spread: idle');
  }
});

// Self-consumption: net metering (export = import): storing surplus never pays wear. With an
// evening price above the midday export price it does, only for the surplus the evening pays for.
test('wear: self-consumption stores surplus only where it pays losses and wear', () => {
  const flat = Array.from({ length: N }, () => 0.25);
  const o = {
    ...base, soc: 0, net: summerNet, allowGridCharge: false, allowExport: false, minimizeGrid: true,
  };
  const charged = (strat) => Object.values(strat).some((v) => v.power > 0);
  for (const planner of [lp, light]) {
    const free = planner.plan({ ...o, prices: flat });
    assert.ok(charged(free), 'without wear it stores surplus');
    assert.ok(Object.values(free).every((v) => !v.noCharge), 'without wear no noCharge');
    const worn = planner.plan({ ...o, prices: flat, wearCost: 0.05 });
    assert.ok(!charged(worn), 'net metering + wear: no storing');
    assert.ok(Object.values(worn).every((v) => v.noCharge), 'every slot noCharge');
    const dyn = flat.map((p, i) => (hour(i) >= 11 && hour(i) < 15 ? 0.05 : p));
    const paid = planner.plan({
      ...o, prices: dyn, exportPrices: dyn, wearCost: 0.05,
    });
    assert.ok(charged(paid), 'cheap midday, dear evening: stores');
    assert.ok(Object.entries(paid).every(([k, v]) => !(v.power > 0) || (hour(k) >= 11 && hour(k) < 15)), 'only in the cheap hours');
    const empty = planner.plan({
      ...o, prices: flat, net: null, homePowerUsage: 300, wearCost: 0.05,
    });
    assert.ok(Object.values(empty).every((v) => v.noCharge), 'empty, nothing to plan: still noCharge');
  }
});

test('wear: self-consumption still stores surplus for a peak over the import limit', () => {
  const flat = Array.from({ length: N }, () => 0.25);
  const peakIdx = 19 * 4;
  const net = summerNet.map((n, i) => (i === peakIdx ? {
    surplusW: 0, usableSurplusW: 0, deficitW: 5000, usableDeficitW: 5000, limitW: 2500, penaltyPerKw: 40,
  } : n));
  for (const planner of [lp, light]) {
    const strat = planner.plan({
      ...base, soc: 0, net, prices: flat, wearCost: 0.05, allowGridCharge: false, allowExport: false, minimizeGrid: true,
    });
    assert.ok(Object.values(strat).some((v) => v.power > 0), 'stores surplus');
    assert.ok(strat[peakIdx].power < 0, 'shaves the peak');
  }
});

test('wear: a later export price does not count in self-consumption', () => {
  const flat = Array.from({ length: N }, () => 0.25);
  const exp = flat.map((p, i) => (hour(i) >= 20 ? 0.6 : p));
  const worth = (allowExport) => light.solarMinW({
    prices: flat, exportPrices: exp, cycleCost: 0.05, chargeEffAt: () => 0.9, maxChargeW: 2200, dischargeEff: 0.92, allowExport,
  }).filter((w) => w !== Infinity).length;
  assert.strictEqual(worth(false), 0);
  assert.ok(worth(true) > 0);
});

// Prod 2026-10-17 17:00: net metering (export 0.017 below import), peak 0.419 at 19:00, minimum
// profit 0.08: storing surplus does not pay, so the charge is kept as idle, not hold (which stores).
test('smart: no hold where storing surplus does not pay', () => {
  const day = {
    17: 0.3566, 18: 0.395, 19: 0.419, 20: 0.3764, 21: 0.3832, 22: 0.3393, 23: 0.3242,
  };
  const hr = (i) => (17 + Math.floor(i / 4)) % 24;
  const prices = Array.from({ length: 124 }, (_, i) => {
    const h = hr(i);
    if (day[h]) return day[h];
    if (h < 7) return 0.29;
    return h >= 10 && h < 17 ? 0.3 : 0.36;
  });
  const exportPrices = prices.map((p) => p - 0.0168);
  const net = prices.map((_, i) => (hr(i) >= 11 && hr(i) < 15
    ? {
      surplusW: 1500, deficitW: 0, usableSurplusW: 1500, usableDeficitW: 0,
    }
    : {
      surplusW: 0, deficitW: 300, usableSurplusW: 0, usableDeficitW: 300,
    }));
  const o = {
    ...base, prices, exportPrices, net, soc: 60, minPriceDelta: 0.08,
  };
  for (const planner of [lp, light]) {
    const s = planner.plan(o);
    assert.ok(s[0].block !== 'hold' && s[0].noCharge, `17:00 ${s[0].block}`);
    const cheap = planner.plan({ ...o, minPriceDelta: 0.02 });
    assert.ok(cheap[0].block === 'hold' && !cheap[0].noCharge, `small minimum profit: 17:00 ${cheap[0].block}`);
  }
});

// Learned settings carry a fixed loss (50 W): a small steady surplus stores badly.
test('low power: surplus stored only above what pays its losses', () => {
  const effAt = (p) => (p - 50 - (2e-5 * p * p)) / p;
  const learned = {
    chargeSpeeds: [2200, 1050, 1625].map((power) => ({ power, eff: effAt(power) })),
    dischargeSpeeds: speeds.dischargeSpeeds,
  };
  const curve = light.steadyEffCurve(learned.chargeSpeeds, 'charge');
  assert.ok(Math.abs(curve(200) - effAt(200)) < 0.01, `200 W ${curve(200)}`);
  assert.strictEqual(curve(1300), light.effCurve(learned.chargeSpeeds)(1300), 'above the lowest speed: as before');
  assert.ok(light.steadyEffCurve(speeds.chargeSpeeds, 'charge')(200) === 0.95, 'two points: no fit, as before');
  const prices = [0.2, 0.2, 0.35, 0.35];
  const minW = (bats) => light.solarMinWFor({
    bats, prices, exportPrices: prices, cycleCost: 0.05, minimizeGrid: false, allowExport: true,
  });
  const w = minW([learned])[0];
  assert.ok(w > 100 && w < 300, `learned: from ${w} W`);
  assert.strictEqual(minW([speeds])[0], 0, 'without a fixed loss: any');
  assert.strictEqual(minW([learned])[2], Infinity, 'nothing dearer later: none');
  const net = prices.map(() => ({
    surplusW: 120, deficitW: 0, usableSurplusW: 120, usableDeficitW: 0,
  }));
  for (const planner of [lp, light]) {
    const s = planner.plan({
      ...base, ...learned, prices, net, soc: 0, minPriceDelta: 0.05, allowGridCharge: false,
    });
    assert.ok(Object.values(s).every((v) => !(v.power > 0)), '120 W surplus not stored');
    assert.ok(s[0].minSolarW > 100, `minSolarW ${s[0].minSolarW}`);
  }
});

// Zero on the meter follows a 300 W deficit: with a 50 W fixed loss covering it is worth less than
// keeping the charge (about 85 %, not the speeds' 94 %). Smart: kept as idle (no surplus worth storing).
test('low power: a small deficit is not covered at a bad efficiency', () => {
  const effAt = (p) => p / (p + 50 + (2e-5 * p * p));
  const learned = {
    chargeSpeeds: speeds.chargeSpeeds,
    dischargeSpeeds: [1700, 800, 1300].map((power) => ({ power, eff: effAt(power) })),
  };
  const flat = { chargeSpeeds: speeds.chargeSpeeds, dischargeSpeeds: learned.dischargeSpeeds.map((sp) => ({ ...sp, eff: 0.94 })) };
  const prices = [0.32, 0.32, 0.32, 0.32, 0.3, 0.3, 0.3, 0.3];
  const net = prices.map(() => ({
    surplusW: 0, deficitW: 300, usableSurplusW: 0, usableDeficitW: 300,
  }));
  const o = {
    ...base, prices, net, soc: 80, allowExport: false,
  };
  for (const planner of [lp, light]) {
    assert.ok(planner.plan({ ...o, ...flat })[0].power < 0, 'flat 94 %: covers');
    const s = planner.plan({ ...o, ...learned });
    assert.ok(s[0].power === 0 && s[0].block === 'idle', `learned: keeps it (${s[0].power} W, ${s[0].block})`);
  }
});

test('split: fewest batteries within their efficient power, then by SoC', () => {
  const split = require('../../lib/strategies/BatterySplit');
  const b = (socPct, active = false) => ({
    socPct, speed: { power: 1050, eff: 0.95 }, maxW: 2200, active,
  });
  assert.deepStrictEqual(split.split([b(50), b(30)], 800, true).map(Math.round), [0, 800], 'charge: emptiest alone');
  assert.deepStrictEqual(split.split([b(50), b(30)], 800, false).map(Math.round), [800, 0], 'discharge: fullest alone');
  assert.deepStrictEqual(split.split([b(50), b(45, true)], 800, true).map(Math.round), [0, 800], 'busy one keeps its turn');
  assert.deepStrictEqual(split.split([b(50), b(35, true)], 800, false).map(Math.round), [800, 0], 'beyond the hysteresis: the other');
  const two = split.split([b(50), b(30)], 1800, true);
  assert.ok(two.every((w) => w > 700 && w <= 1050), `two within efficient power: ${two}`);
  const full = split.split([b(50), b(30)], 3000, true);
  assert.ok(Math.abs(full[0] + full[1] - 3000) < 1 && full.every((w) => w <= 2200), `above: ${full}`);
  assert.ok(split.split([{ ...b(50), maxW: 300 }, { ...b(30), maxW: 200 }], 800, true).reduce((x, y) => x + y) < 501, 'limits hold');
  assert.deepStrictEqual(split.split([{ ...b(90), speed: { power: 1050, eff: 0.97 } }, b(10)], 800, false).map(Math.round), [800, 0], 'most efficient first');
  assert.deepStrictEqual(split.split([b(50), b(30)], 1100, true).map(Math.round), [0, 1100], 'a little above: still one');
  assert.ok(split.split([b(50, true), b(30, true)], 1000, true).every((w) => w > 0), 'two busy: stay two a little below');
  assert.ok(split.split([b(50, true), b(30, true)], 900, true).filter((w) => w > 0).length === 1, 'further below: one');
});

// Two alike Sessys (screenshot 2026-10-17): the LP split an equal-cost plan at random.
test('group of 2 alike Sessys: both share the plan, saving unchanged', () => {
  const sessy = (soc) => ({ soc, batCapacity: 5, ...speeds });
  const net = summerNet.map((n, i) => (hour(i) >= 10 && hour(i) < 16 ? { ...n, surplusW: 900, usableSurplusW: 900 } : n));
  const o = {
    ...base, prices: dayPrices, exportPrices: dayPrices.map(() => 0.05), net, batteries: [sessy(4), sessy(6)],
  };
  for (const planner of [lp, light]) {
    const plans = planner.planEach(o);
    const cycled = plans.map((p) => Object.values(p).reduce((a, v) => a + Math.abs(v.power * v.duration) / 60000, 0));
    console.log(`     cycled kWh ${cycled.map((v) => v.toFixed(2)).join(' / ')}`);
    assert.ok(Math.min(...cycled) > 0.6 * Math.max(...cycled), 'both take part');
    plans.forEach((p) => Object.values(p).forEach((x) => assert.ok(x.soc >= 0 && x.soc <= 100, `soc ${x.soc}`)));
    Object.keys(plans[0]).forEach((k) => {
      const both = plans.map((p) => p[k].power);
      assert.ok(!(both[0] > 0 && both[1] < 0) && !(both[0] < 0 && both[1] > 0), `slot ${k} one charges, one discharges`);
      const room = plans.every((p) => p[k].soc < 90);
      assert.ok(!(both[0] > 0 && both[1] > 0) || !room || both[0] + both[1] > 1050 / 1.1, `slot ${k}: two at low power ${both}`);
    });
  }
  const one = lp.planEach(o);
  const single = [lp.plan({
    ...o,
    batteries: null,
    soc: 5,
    batCapacity: 10,
    chargeSpeeds: speeds.chargeSpeeds.map((s) => ({ ...s, power: 2 * s.power })),
    dischargeSpeeds: speeds.dischargeSpeeds.map((s) => ({ ...s, power: 2 * s.power })),
  })];
  const caps = { ...o, batteries: null, batCapacity: 10 };
  console.log(`     group ${evaluate(one, o).toFixed(3)}, as one battery ${evaluate(single, caps).toFixed(3)}`);
  assert.ok(Math.abs(evaluate(one, o) - evaluate(single, caps)) < 0.02, 'same cost as one double battery');
});

// Use alike over time (BatteryUse): the cheapest per kWh cycled first, of about equally cheap
// ones the least used.
test('group: cheapest first, of about equally cheap ones the least used', () => {
  const better = {
    chargeSpeeds: speeds.chargeSpeeds.map((sp) => ({ ...sp, eff: sp.eff + 0.005 })),
    dischargeSpeeds: speeds.dischargeSpeeds.map((sp) => ({ ...sp, eff: sp.eff + 0.005 })),
  };
  const net = winterNet.map((n, i) => {
    const w = hour(i) >= 17 && hour(i) < 22 ? 700 : 200;
    return { ...n, deficitW: w, usableDeficitW: w };
  });
  const bat = (o) => ({
    soc: 30, batCapacity: 5, ...speeds, ...o,
  });
  const o = (b1, b2) => ({
    ...base, prices: dayPrices, exportPrices: dayPrices.map(() => 0.05), net, wearCost: 0.02, batteries: [bat({ ...better, ...b1 }), bat(b2)],
  });
  const cycled = (plans) => plans.map((p) => Object.values(p).reduce((a, v) => a + Math.abs(v.power * v.duration) / 60000, 0));
  for (const [name, planner] of [['LP', lp], ['light', light]]) {
    const eff = cycled(planner.planEach(o({ cycles: 3 }, { cycles: 3 })));
    const lag = cycled(planner.planEach(o({ cycles: 3 }, { cycles: 1 })));
    const dear = cycled(planner.planEach(o({ cycles: 3 }, { cycles: 1, wear: 0.06 })));
    console.log(`     ${name}: alike ${eff.map((v) => v.toFixed(2))}, 2nd less used ${lag.map((v) => v.toFixed(2))}, 2nd dearer ${dear.map((v) => v.toFixed(2))}`);
    assert.ok(eff[0] > eff[1], `${name}: used alike, most efficient first`);
    assert.ok(lag[1] > lag[0], `${name}: least used first`);
    assert.ok(dear[0] > dear[1], `${name}: cheapest first`);
  }
  const use = require('../../lib/strategies/BatteryUse');
  let st = use.createState(1);
  [50, 51, 50, 51, 60, 40, 95, 94].forEach((soc) => {
    st = use.onSoc(st, soc);
  });
  assert.strictEqual(Math.round(st.cycles * 1000) / 1000, 1.15, `jitter and jumps are no use (${st.cycles})`);
});

test('group LP: own wear prunes, use balance does not price out a cycle', () => {
  const use = require('../../lib/strategies/BatteryUse');
  assert.deepStrictEqual(use.costClasses([{ effC: 0.90, effD: 0.92 }, { effC: 0.91, effD: 0.92 }], 0.25), [0, 0], 'about equal: one class');
  const n = 96;
  const one = { chargeSpeeds: [{ power: 2000, eff: 1 }], dischargeSpeeds: [{ power: 2000, eff: 1 }] };
  const net = Array.from({ length: n }, () => ({
    surplusW: 0, deficitW: 3000, usableSurplusW: 0, usableDeficitW: 3000,
  }));
  const kwh = (plans) => plans.map((p) => Object.values(p).reduce((a, v) => a + Math.abs(v.power * v.duration) / 60000, 0));
  const at = (lo, hi) => Array.from({ length: n }, (_, i) => {
    if (hour(i) < 4) return lo;
    return hour(i) < 8 ? hi : 0.20;
  });
  const o = {
    priceInterval: 15, startMinute: 0, net, allowExport: false,
  };
  const bat = (b) => ({ batCapacity: 5, ...one, ...b });
  const wear = kwh(lp.planEach({
    ...o,
    prices: at(0.16, 0.24),
    minPriceDelta: 0.04,
    wearCost: 0.15,
    batteries: [bat({ soc: 0, wear: 0 }), bat({ soc: 0, wear: 0.3 })],
  }));
  assert.ok(wear[0] > 1 && wear[1] < 0.01, `the cheap one cycles (${wear})`);
  const full = kwh(lp.planEach({
    ...o,
    prices: at(0.20, 0.215),
    minPriceDelta: 0.01,
    wearCost: 0,
    batteries: [bat({ soc: 0, cycles: 3 }), bat({ soc: 100, cycles: 1 })],
  }));
  assert.ok(full[0] > 1, `least used full: the other still cycles (${full})`);
});

test('zero covering the deficit in part gets the planned power as cap; rounding is no grid part', () => {
  // Too little stored for all dear hours: 30 ct hours in part, 45 ct hours in full (export 5 ct)
  const prices = [...Array(4).fill(0.30), ...Array(3).fill(0.45), ...Array(17).fill(0.25)];
  const o = {
    prices,
    exportPrices: prices.map(() => 0.05),
    priceInterval: 60,
    minPriceDelta: 0.05,
    wearCost: 0.07,
    startMinute: 0,
    soc: 30,
    batCapacity: 11,
    chargeSpeeds: [{ power: 4400, eff: 0.9 }, { power: 2560, eff: 0.92 }],
    dischargeSpeeds: [{ power: 3300, eff: 0.91 }, { power: 2560, eff: 0.93 }],
    net: prices.map(() => ({
      surplusW: 0, deficitW: 600, usableSurplusW: 0, usableDeficitW: 600,
    })),
  };
  for (const [name, planner] of [['LP', lp], ['light', light]]) {
    const p = planner.plan(o);
    const dear = [4, 5, 6].map((t) => p[t]);
    assert.ok(dear.every((x) => x.block === 'xom' && !x.homeCapW), `${name}: dear hours in full ${JSON.stringify(dear)}`);
    const part = [1, 2, 3].map((t) => p[t]).filter((x) => x.block === 'xom');
    // Within 3 % (PART_SHARE) of the deficit counts as covered: no cap.
    const capped = part.filter((x) => x.homeCapW === -x.power && x.homeCapW < 600);
    assert.ok(capped.length && part.every((x) => capped.includes(x) || (!x.homeCapW && -x.power >= 600 * 0.97)), `${name}: 30 ct in part ${JSON.stringify(part)}`);
    assert.ok(Object.values(p).every((x) => x.block !== 'discharge'), `${name}: no export at 5 ct`);
  }
  // One energy step to charge without a surplus to follow: still a grid charge
  const one = light.plan({
    ...base,
    priceInterval: 60,
    prices: [0.10, ...Array(5).fill(0.45)],
    soc: 99,
    net: Array.from({ length: 6 }, () => ({
      surplusW: 0, deficitW: 600, usableSurplusW: 0, usableDeficitW: 600,
    })),
  });
  assert.strictEqual(one[0].block, 'charge', JSON.stringify(one[0]));
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;

// --- Short gaps in grid charging are bridged (15-minute prices)
{
  const { bridgeGaps } = require('../../lib/strategies/LightPlanner');
  const slot = (power, block, price, soc) => ({
    power, duration: power ? 15 : 0, soc, price, exportPrice: price, block,
  });
  const make = (gapPrice) => [{
    0: slot(1000, 'charge', 0.1, 10),
    1: slot(1000, 'charge', 0.1, 15),
    2: { ...slot(0, 'hold', gapPrice, 15), quiet: true },
    3: slot(1000, 'charge', 0.1, 20),
    4: slot(0, 'idle', 0.3, 20),
  }];
  let [st] = bridgeGaps(make(0.101), { priceInterval: 15 });
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => st[i].block), ['charge', 'charge', 'charge', 'charge'], 'gap bridged');
  assert.strictEqual(st[2].power, 750, 'same energy over the run');
  assert.strictEqual(st[2].quiet, undefined);
  assert.strictEqual(st[3].soc, 20, 'SoC at the end kept');
  assert.strictEqual(st[4].block, 'idle');
  [st] = bridgeGaps(make(0.2), { priceInterval: 15 });
  assert.strictEqual(st[2].block, 'hold', 'dear gap kept');
  [st] = bridgeGaps(make(0.101), { priceInterval: 15, limited: (t) => t === 2 });
  assert.strictEqual(st[2].block, 'hold', 'import limit in the gap: kept');
  [st] = bridgeGaps(make(0.101), { priceInterval: 60 });
  assert.strictEqual(st[2].block, 'hold', 'hourly slots: no short gaps');
  console.log('battery gap bridging tests passed');
}
