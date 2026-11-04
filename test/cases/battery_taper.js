/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/BatteryTaper.js and the taper limits in both planners and
// BatteryCalibration.chooseTargets(). Run: node test/cases/battery_taper.js

const assert = require('assert');
const Taper = require('../../lib/strategies/BatteryTaper');
const Cal = require('../../lib/strategies/BatteryCalibration');
const Lp = require('../../lib/strategies/PrecisePlanner');
const Light = require('../../lib/strategies/LightPlanner');

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

const MIN = 60 * 1000;
// A battery taking k x (101 - SoC) W near full, asked 2200 W: one sample a minute.
const learn = (state, {
  k = 100, from = 85, to = 99, setW = 2200, dir = 1,
} = {}) => {
  let s = state;
  let now = 10 * MIN;
  for (let soc = from; dir > 0 ? soc <= to : soc >= to; soc += dir) {
    const room = (dir > 0 ? 100 - soc : soc) + 1;
    s = Taper.onTick(s, {
      now, socPct: soc, setW: dir * setW, actW: dir * Math.min(setW, k * room), setChangeTm: 0,
    }).state;
    now += MIN;
  }
  return s;
};

test('learns k near full, only when limited and settled', () => {
  const s = learn(Taper.createState());
  assert.ok(Taper.learned(s, 'charge'), JSON.stringify(s));
  assert.ok(Math.abs(s.charge.k - 100) < 1, `k ${s.charge.k}`);
  assert.ok(!Taper.learned(s, 'discharge'));
  assert.strictEqual(Taper.limitW(s, 'charge', 99), 200);
  assert.strictEqual(Taper.limitW(s, 'discharge', 5), Infinity);
});

test('no samples: mid SoC, following, just changed, or stopped', () => {
  const tick = (o) => Taper.onTick(Taper.createState(), {
    now: 10 * MIN, socPct: 95, setW: 2200, actW: 600, setChangeTm: 0, ...o,
  }).sample;
  assert.ok(tick({}));
  assert.strictEqual(tick({ socPct: 50 }), null);
  assert.strictEqual(tick({ actW: 2150 }), null);
  assert.strictEqual(tick({ setChangeTm: 10 * MIN - 30 * 1000 }), null);
  assert.ok(tick({ setChangeTm: 10 * MIN - 30 * 1000, capped: true }), 'capped: lag known');
  assert.strictEqual(tick({ actW: 20 }), null);
  assert.strictEqual(tick({ setW: null }), null);
});

test('discharge near empty', () => {
  const s = learn(Taper.createState(), {
    k: 80, from: 15, to: 1, setW: 1700, dir: -1,
  });
  assert.ok(Taper.learned(s, 'discharge'));
  assert.strictEqual(Math.round(Taper.limitW(s, 'discharge', 4)), 400);
});

test('plan limits: in the planner space above the reserve', () => {
  const s = learn(learn(Taper.createState()), {
    k: 80, from: 15, to: 1, setW: 1700, dir: -1,
  });
  const { k } = s.charge;
  const { chargeLimit, dischargeLimit } = Taper.planLimits(s, { capKwh: 5, reservePct: 10 });
  // Full (planner 4.5 kWh = 100 %): k x 1 W; half the planner range (55 % real): k x 46.
  assert.ok(Math.abs((chargeLimit.a - (chargeLimit.b * 4.5)) - k) < 1e-6);
  assert.ok(Math.abs((chargeLimit.a - (chargeLimit.b * 2.25)) - (k * 46)) < 1e-6);
  // Planner empty = 10 % real: kd x 11.
  assert.ok(Math.abs(dischargeLimit.a - (s.discharge.k * 11)) < 1e-6);
});

const n = 32;
const cheap = Array.from({ length: n }, (_, t) => (t < 16 ? 0.1 : 0.4));
const speeds = {
  chargeSpeeds: [{ power: 2200, eff: 0.92 }],
  dischargeSpeeds: [{ power: 2200, eff: 0.92 }],
};
// 1.5 h of cheap prices: 3.3 kWh at full power fills 5 kWh from 40 % (3 kWh), not with the taper.
const opts = {
  prices: cheap, priceInterval: 15, minPriceDelta: 0.05, soc: 40, batCapacity: 5, homePowerUsage: 3000, ...speeds,
};
const taper = Taper.planLimits({ charge: { k: 60, n: 20, tm: 0 } }, { capKwh: 5 });
[['LP', Lp], ['light', Light]].forEach(([name, planner]) => {
  test(`${name}: the taper slows charging near full`, () => {
    const free = planner.plan(opts);
    const tapered = planner.plan({ ...opts, ...taper });
    const powerAt = (s, socPct) => Object.values(s).filter((x) => x.power > 0 && x.soc >= socPct).map((x) => x.power);
    assert.ok(Math.max(...powerAt(free, 96)) > 60 * 7, 'free: no taper');
    // At 96-100 % the limit is 60 x (101 - SoC) W: at most ~400 W on average in such a slot.
    powerAt(tapered, 96).forEach((w) => assert.ok(w <= 60 * 7, `${w} W near full`));
    assert.ok(tapered[15].soc >= 99, `full at the end of the cheap hours: ${tapered[15].soc} %`);
    const maxW = Math.max(...Object.values(tapered).map((x) => x.power));
    assert.ok(maxW >= 1900, `full power below the taper: ${maxW} W`);
  });
});

test('chooseTargets: the taper takes more slots to full', () => {
  const prices = Array.from({ length: 96 }, (_, t) => (t >= 40 && t < 52 ? 0.1 : 0.3));
  const base = {
    phase: 'full', startMs: 0, slotMin: 15, prices, socPct: 50, capKwh: 5, maxChargeW: 2200, maxDischargeW: 2200,
  };
  const free = Cal.chooseTargets(base);
  const slow = Cal.chooseTargets({ ...base, limitW: (dir, pct) => 60 * (101 - pct) });
  assert.ok(slow.fullByMs >= free.fullByMs, `${slow.fullByMs} vs ${free.fullByMs}`);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
}
