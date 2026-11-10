/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/BatteryCalibration.js and the SoC bounds in both planners.
// Run: node test/cases/battery_calibration.js

const assert = require('assert');
const Cal = require('../../lib/strategies/BatteryCalibration');
const Control = require('../../lib/strategies/BatteryControl');
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
const DAY = 24 * 60 * MIN;
const startMs = Date.UTC(2026, 9, 27, 17, 0);
// 15-minute slots from 18:00 local: evening peak 18-21, cheap night 01-05, else middle.
const hourOf = (t) => (18 + (t / 4)) % 24;
const pricesFor = (n) => Array.from({ length: n }, (_, t) => {
  const h = hourOf(t);
  if (h >= 18 && h < 21) return 0.35;
  return h >= 1 && h < 5 ? 0.12 : 0.22;
});
const prices = pricesFor(96);
const net = prices.map(() => ({
  surplusW: 0, deficitW: 400, usableSurplusW: 0, usableDeficitW: 400,
}));
const battery = {
  socPct: 60, capKwh: 5, maxChargeW: 2200, maxDischargeW: 1700,
};
const speeds = {
  chargeSpeeds: [{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }],
  dischargeSpeeds: [{ power: 1700, eff: 0.92 }, { power: 765, eff: 0.96 }],
};
const idxOf = (ms) => Math.round((ms - startMs) / (15 * MIN)) - 1;

test('due after the days, at once when requested, never while running', () => {
  const s = Cal.createState(0);
  assert.strictEqual(Cal.isDue(s, 7, 6 * DAY), false);
  assert.strictEqual(Cal.isDue(s, 7, 7 * DAY), true);
  assert.strictEqual(Cal.isDue(s, 0, 30 * DAY), false);
  assert.strictEqual(Cal.isDue({ ...s, requested: true }, 0, 1), true);
  assert.strictEqual(Cal.isDue(Cal.start(s, 7 * DAY, {}), 7, 8 * DAY), false);
});

test('targets: empty in the evening peak, full after the cheap night', () => {
  const t = Cal.chooseTargets({
    phase: 'empty', startMs, slotMin: 15, prices, net, ...battery,
  });
  const e = idxOf(t.emptyByMs);
  const f = idxOf(t.fullByMs);
  assert.ok(hourOf(e) >= 18 && hourOf(e) < 21, `empty at ${hourOf(e)}`);
  assert.ok(hourOf(f) >= 1 && hourOf(f) < 5, `full at ${hourOf(f)}`);
});

test('targets: only full, the cheapest soonest', () => {
  const t = Cal.chooseTargets({
    phase: 'full', startMs, slotMin: 15, prices, net, ...battery,
  });
  assert.strictEqual(t.emptyByMs, null);
  const f = idxOf(t.fullByMs);
  assert.ok(hourOf(f) >= 1 && hourOf(f) < 5, `full at ${hourOf(f)}`);
});

test('targets: null when the prices do not reach far enough', () => {
  assert.strictEqual(Cal.chooseTargets({
    phase: 'empty', startMs, slotMin: 15, prices: prices.slice(0, 6), ...battery,
  }), null);
});

test('targets: 48 h of 15-minute slots in reasonable time', () => {
  const t0 = Date.now();
  Cal.chooseTargets({
    phase: 'empty', startMs, slotMin: 15, prices: pricesFor(192), ...battery,
  });
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('bounds: per plan slot, past targets left out', () => {
  const s = Cal.start(Cal.createState(0), startMs, { emptyByMs: startMs + (8 * 15 * MIN), fullByMs: startMs + (40 * 15 * MIN) });
  assert.deepStrictEqual(Cal.socBounds(s, { startMs, slotMin: 15, slots: 96 }), { 7: { max: 0 }, 39: { min: 100 } });
  const later = startMs + (10 * 15 * MIN);
  assert.deepStrictEqual(Cal.socBounds(s, { startMs: later, slotMin: 15, slots: 96 }), { 29: { min: 100 } });
  assert.strictEqual(Cal.socBounds(Cal.createState(0), { startMs, slotMin: 15, slots: 96 }), null);
});

// Asked on while doing nothing, from tm for ms: the stop fires after STOP_MS, once.
const run = (state, {
  from, ms, socPct, setW, actW,
}) => {
  let s = state;
  const events = [];
  for (let now = from; now <= from + ms; now += 10 * 1000) {
    const r = Cal.onTick(s, {
      now, socPct, setW, actW,
    });
    s = r.state;
    if (r.event) events.push({ ...r, now });
  }
  return { state: s, events };
};

test('stop: empty, then full ends the calibration', () => {
  let s = Cal.start(Cal.createState(0), DAY, { emptyByMs: 2 * DAY, fullByMs: 3 * DAY });
  let r = run(s, {
    from: DAY, ms: 4 * MIN, socPct: 2, setW: -1700, actW: 0,
  });
  assert.strictEqual(r.events.length, 0);
  r = run(s, {
    from: DAY, ms: 10 * MIN, socPct: 2, setW: -1700, actW: -20,
  });
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.state.phase, 'full');
  s = r.state;
  r = run(s, {
    from: DAY + (20 * MIN), ms: 10 * MIN, socPct: 100, setW: 2200, actW: 10,
  });
  assert.strictEqual(r.events.length, 1);
  assert.ok(r.events[0].done);
  assert.strictEqual(r.state.phase, null);
  assert.strictEqual(r.state.lastTm, r.events[0].now);
});

test('stop: still delivering at 0 % is no stop; the time limit ends it', () => {
  const s = Cal.start(Cal.createState(0), DAY, { emptyByMs: 2 * DAY, fullByMs: 3 * DAY });
  let r = run(s, {
    from: DAY, ms: 30 * MIN, socPct: 0, setW: -1700, actW: -1500,
  });
  assert.strictEqual(r.events.length, 0);
  r = run(s, {
    from: DAY, ms: Cal.TAIL_MAX_MS + MIN, socPct: 0, setW: -1700, actW: -1500,
  });
  assert.strictEqual(r.events.length, 1);
  assert.ok(r.events[0].timeout);
  assert.strictEqual(r.state.phase, 'full');
});

test('stop: not asked (setpoint low or not controlled) is no stop', () => {
  const s = Cal.start(Cal.createState(0), DAY, { emptyByMs: 2 * DAY, fullByMs: 3 * DAY });
  assert.strictEqual(run(s, {
    from: DAY, ms: 30 * MIN, socPct: 2, setW: -100, actW: 0,
  }).events.length, 0);
  assert.strictEqual(run(s, {
    from: DAY, ms: 30 * MIN, socPct: 2, setW: null, actW: 0,
  }).events.length, 0);
});

test('stop: a battery with its own minimum (10 %) counts as empty in a calibration only', () => {
  const s = Cal.start(Cal.createState(0), DAY, { emptyByMs: 2 * DAY, fullByMs: 3 * DAY });
  const at10 = {
    from: DAY, ms: 10 * MIN, socPct: 10, setW: -1700, actW: 0,
  };
  assert.strictEqual(run(s, at10).state.phase, 'full');
  assert.strictEqual(run(Cal.createState(0), at10).events.length, 0);
});

test('natural: a full after an empty counts as a calibration', () => {
  let s = Cal.createState(0);
  let r = run(s, {
    from: DAY, ms: 10 * MIN, socPct: 100, setW: 2200, actW: 0,
  });
  assert.strictEqual(r.state.lastTm, 0, 'full without empty: no calibration');
  s = run(r.state, {
    from: 2 * DAY, ms: 10 * MIN, socPct: 0, setW: -1700, actW: 0,
  }).state;
  r = run(s, {
    from: 3 * DAY, ms: 10 * MIN, socPct: 100, setW: 2200, actW: 0,
  });
  assert.ok(r.events[0].done);
  assert.ok(r.state.lastTm >= 3 * DAY);
});

test('tail: full power at 0 % and 100 %, action calibrate', () => {
  const base = {
    now: startMs, gridW: 0, batteryW: 0, capacityKwh: 5, maxChargeW: 2200, maxDischargeW: 1700,
  };
  const slot = {
    block: 'idle', soc: 0, index: 0, endMs: startMs + (15 * MIN),
  };
  assert.strictEqual(Cal.tail(Cal.start(Cal.createState(0), 0, {}), 4), 'empty');
  assert.strictEqual(Cal.tail(Cal.start(Cal.createState(0), 0, {}), 50), null);
  assert.strictEqual(Control.decide({
    ...base, mode: 'smart', slot, calibrate: 'empty', socPct: 0,
  }).powerW, -1700);
  assert.strictEqual(Control.decide({
    ...base, mode: 'smart', slot, calibrate: 'empty', socPct: 0, reserveForPeak: false,
  }).powerW, -1700, 'without peak shaving too: else the empty stop is never seen');
  assert.strictEqual(Control.decide({
    ...base, mode: 'self_consumption', slot, calibrate: 'full', socPct: 100,
  }).powerW, 2200);
  assert.strictEqual(Control.actionFor({ block: 'charge', calibrate: 'full' }), 'calibrate');
});

const planOpts = {
  prices, priceInterval: 15, minPriceDelta: 0.08, soc: 60, batCapacity: 5, net, ...speeds,
};
const bounds = { 7: { max: 0 }, 38: { min: 100 } };
[['LP', Lp], ['light', Light]].forEach(([name, planner]) => {
  test(`${name}: empty and full at the bounds`, () => {
    const s = planner.plan({ ...planOpts, socBounds: bounds });
    assert.ok(s[7].soc <= 1, `soc ${s[7].soc} at the empty bound`);
    assert.ok(s[38].soc >= 99, `soc ${s[38].soc} at the full bound`);
  });
  test(`${name}: self-consumption (no export, no grid charge) still meets the bounds with grid charge`, () => {
    const s = planner.plan({
      ...planOpts, socBounds: { 30: { max: 0 }, 60: { min: 100 } }, allowExport: false, allowGridCharge: true, minimizeGrid: true,
    });
    assert.ok(s[30].soc <= 1, `soc ${s[30].soc} at the empty bound`);
    assert.ok(s[60].soc >= 99, `soc ${s[60].soc} at the full bound`);
  });
  test(`${name}: an impossible bound is missed, not an error`, () => {
    const s = planner.plan({ ...planOpts, socBounds: { 0: { max: 0 } } });
    assert.ok(s[0].soc > 0);
  });
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
}

test('full phase: the charge window from the SoC now; expired after 3 days', () => {
  const p = [0.5, 0.5, 0.2, 0.5, 0.5, 0.5, 0.5, 0.5];
  const o = {
    phase: 'full', startMs: 0, slotMin: 60, prices: p, capKwh: 5, maxChargeW: 2500, maxDischargeW: 2500,
  };
  assert.strictEqual(Cal.chooseTargets({ ...o, socPct: 0 }).fullByMs, 4 * 3600000, 'from empty: 2 h + top-off');
  assert.strictEqual(Cal.chooseTargets({ ...o, socPct: 60 }).fullByMs, 3 * 3600000, 'half full: the cheap slot');
  const s = Cal.start(Cal.createState(0), 0, {});
  assert.ok(!Cal.isExpired(s, 2 * DAY));
  assert.ok(Cal.isExpired(s, 3.1 * DAY));
  assert.ok(!Cal.isExpired(Cal.end(s, 3.1 * DAY), 4 * DAY));
});
