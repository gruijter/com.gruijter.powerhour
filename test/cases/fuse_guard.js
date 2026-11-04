/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/FuseGuard.js and its use in BatteryControl.decide().
// Run: node test/cases/fuse_guard.js

const assert = require('assert');
const G = require('../../lib/strategies/FuseGuard');
const C = require('../../lib/strategies/BatteryControl');

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

const now = Date.UTC(2026, 9, 19, 18, 0);

test('margin: 1x35A 5 % = 7648 W, bad input the default, clamped', () => {
  assert.strictEqual(G.withMargin(8050, 5), 7648);
  assert.strictEqual(G.withMargin(8050, undefined), 7648);
  assert.strictEqual(G.withMargin(8050, 0), 8050);
  assert.strictEqual(G.withMargin(8050, 90), 4025);
});

test('stale after 30 s', () => {
  assert.strictEqual(G.isStale({ tm: now - 29000, now }), false);
  assert.strictEqual(G.isStale({ tm: now - 31000, now }), true);
  assert.strictEqual(G.isStale({ tm: undefined, now }), false);
  // A 60 s source: 3 of its intervals, at most 5 min.
  assert.strictEqual(G.isStale({ tm: now - 120000, now, intervalMs: 60000 }), false);
  assert.strictEqual(G.isStale({ tm: now - 190000, now, intervalMs: 60000 }), true);
  assert.strictEqual(G.isStale({ tm: now - 310000, now, intervalMs: 600000 }), true);
  assert.strictEqual(Math.round(G.readingInterval(1000, 60000)), 6900);
});

test('overload: shed only after 30 s above the limit, reset below it', () => {
  let s = G.overloadStep({
    importW: 8000, limitW: 7648, now, overSince: null,
  });
  assert.deepStrictEqual(s, { overSince: now, shed: false });
  s = G.overloadStep({
    importW: 8000, limitW: 7648, now: now + 29000, overSince: s.overSince,
  });
  assert.strictEqual(s.shed, false);
  assert.strictEqual(G.overloadStep({
    importW: 8000, limitW: 7648, now: now + 30000, overSince: now,
  }).shed, true);
  assert.deepStrictEqual(G.overloadStep({
    importW: 7000, limitW: 7648, now: now + 30000, overSince: now,
  }), { overSince: null, shed: false });
  assert.strictEqual(G.overloadStep({
    importW: 99999, limitW: null, now, overSince: now - 60000,
  }).shed, false);
});

test('release: held 10 min, room for the charger, fresh reading', () => {
  const o = {
    shedTm: now, now: now + G.SHED_HOLD_MS, headroomW: 4000, needW: 3700, stale: false,
  };
  assert.strictEqual(G.mayRelease(o), true);
  assert.strictEqual(G.mayRelease({ ...o, now: now + G.SHED_HOLD_MS - 1 }), false);
  assert.strictEqual(G.mayRelease({ ...o, headroomW: 3000 }), false);
  assert.strictEqual(G.mayRelease({ ...o, stale: true }), false);
});

test('freeze: never more power, never the other direction', () => {
  assert.strictEqual(G.freeze(2200, 1000), 1000);
  assert.strictEqual(G.freeze(500, 1000), 500);
  assert.strictEqual(G.freeze(-300, 1000), 0);
  assert.strictEqual(G.freeze(-1700, -800), -800);
  assert.strictEqual(G.freeze(400, -800), 0);
  assert.strictEqual(G.freeze(400, 0), 0);
});

const base = {
  now, socPct: 50, capacityKwh: 5, maxChargeW: 2200, maxDischargeW: 1700,
};
test('decide: export above the fuse forces less discharge / more charge', () => {
  // Full discharge while 9000 W export with a 7648 W limit: 1352 W too much.
  assert.strictEqual(C.decide({
    ...base, mode: 'discharge', slot: null, gridW: -9000, batteryW: -1700, minW: -1700 - (7648 - 9000),
  }).powerW, -350);
  // Idle with export above the fuse: charges.
  assert.strictEqual(C.decide({
    ...base, mode: 'idle', slot: null, gridW: -8648, batteryW: 0, minW: 1000,
  }).powerW, 1000);
  // Within the limit: no effect.
  assert.strictEqual(C.decide({
    ...base, mode: 'idle', slot: null, gridW: -3000, batteryW: 0, minW: -4648,
  }).powerW, 0);
});

test('decide: stale grid keeps the last power', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'charge', slot: null, gridW: 0, batteryW: 800, stale: true,
  }).powerW, 800);
  assert.strictEqual(C.decide({
    ...base, mode: 'charge', slot: null, gridW: 0, batteryW: -500, stale: true,
  }).powerW, 0);
});

test('variable EV charger: cut by the overload, off below its minimum, raised with room', () => {
  assert.strictEqual(G.reduceTo({ currentW: 7400, overW: 900, minW: 1400 }), 6500);
  assert.strictEqual(G.reduceTo({ currentW: 2000, overW: 900, minW: 1400 }), null);
  assert.strictEqual(G.raiseCap({ capW: 4000, headroomW: 300, maxW: 7400 }), 4000);
  assert.strictEqual(G.raiseCap({ capW: 4000, headroomW: 2000, maxW: 7400 }), 5700);
  assert.strictEqual(G.raiseCap({ capW: 3500, headroomW: 548, maxW: 3680 }), null);
  assert.strictEqual(G.raiseCap({ capW: 4000, headroomW: 4000, maxW: 7400 }), null);
});

test('phase room: the device\'s most loaded phase, times its phases', () => {
  const phaseW = [4000, 1000, -2000]; // limit 5462 less the 100 W control reserve: room 1362, 4362, 5362
  const room = (spec) => G.phaseRoomW({ phaseW, limitW: 5462, spec });
  assert.strictEqual(room({ n: 1, set: [1] }), 4362);
  assert.strictEqual(room({ n: 3, set: [0, 1, 2] }), 3 * 1362);
  assert.strictEqual(room({ n: 1, set: null }), 1362, '1 phase, unknown which: the worst');
  assert.strictEqual(room({ n: null, set: null, powerW: 3680 }), 1362, 'unknown, fits one phase: 1');
  assert.strictEqual(room({ n: null, set: null, powerW: 11000 }), 3 * 1362, 'unknown, above one phase: 3');
  assert.strictEqual(G.phaseRoomW({
    phaseW, limitW: 5462, spec: { n: 1, set: [1] }, reservedW: 500,
  }), 3862);
  // An 11 kW 3-phase charger reserves 3667 W per phase, not 11 kW on each.
  const reservedW = G.perPhaseW(11000, { n: 3, set: [0, 1, 2] }, 5462);
  assert.deepStrictEqual(reservedW.map(Math.round), [3667, 3667, 3667]);
  assert.strictEqual(Math.round(G.phaseRoomW({
    phaseW, limitW: 5462, spec: { n: 1, set: [1] }, reservedW,
  })), 695);
  assert.deepStrictEqual(G.perPhaseW(3680, { n: 1, set: [2] }), [0, 0, 3680]);
  assert.deepStrictEqual(G.perPhaseW(3680, { n: null, set: null, powerW: 3680 }, 5462), [3680, 3680, 3680], 'unknown which: on each');
});

test('phase cut: only a device on an overloaded phase, by its phase count', () => {
  const phaseOverW = [1500, -2000, -3000];
  assert.strictEqual(G.phaseCutW({ phaseOverW, spec: { n: 1, set: [0] } }), 1500);
  assert.strictEqual(G.phaseCutW({ phaseOverW, spec: { n: 1, set: [1] } }), 0);
  assert.strictEqual(G.phaseCutW({ phaseOverW, spec: { n: 3, set: [0, 1, 2] } }), 4500);
  assert.strictEqual(G.phaseCutW({ phaseOverW, spec: { n: null, set: null } }), 4500, 'unknown: 3 phases');
  assert.strictEqual(G.phaseCutW({ phaseOverW: [-1, -2, -3], spec: {} }), 0);
});

test('phases overlap: shared phase, or unknown', () => {
  assert.strictEqual(G.phasesOverlap({ set: [0] }, { set: [1] }), false);
  assert.strictEqual(G.phasesOverlap({ set: [0] }, { set: [0, 1, 2] }), true);
  assert.strictEqual(G.phasesOverlap({ set: null }, { set: [1] }), true);
});

test('overload step on overW', () => {
  assert.strictEqual(G.overloadStep({ overW: -5, now, overSince: null }).overSince, null);
  assert.deepStrictEqual(G.overloadStep({ overW: 10, now, overSince: now - G.SHED_AFTER_MS }), { overSince: now - G.SHED_AFTER_MS, shed: true });
});

test('connection limits: per phase and total', () => {
  const GC = require('../../lib/helpers/GridConnection'); // eslint-disable-line global-require
  assert.strictEqual(GC.phaseLimitFromSettings({ connectionAmps: 25, connectionVoltage: 230 }), 5750);
  assert.strictEqual(GC.limitFromSettings({ connectionPhases: '3', connectionAmps: 25, connectionVoltage: 230 }), 17250);
  assert.strictEqual(GC.limitFromSettings({ connectionPhases: '1', connectionAmps: 35, connectionVoltage: 230 }), 8050);
  assert.strictEqual(GC.limitFromSettings({ connectionPhases: '1', connectionAmps: 0 }), 17250, 'bad settings: the default');
  assert.strictEqual(GC.limitFromSettings(undefined), 17250);
});

test('planner: no discharge above the export limit', () => {
  const { getStrategy } = require('../../lib/strategies/PrecisePlanner'); // eslint-disable-line global-require
  const net = (exportLimitW) => [0, 1, 2, 3].map(() => ({
    surplusW: 7000, deficitW: 0, usableSurplusW: 7000, usableDeficitW: 0, limitW: null, penaltyPerKw: null, exportLimitW,
  }));
  const plan = (lim) => Object.values(getStrategy({
    prices: [0.5, 0.5, 0.1, 0.1], exportPrices: [0.5, 0.5, 0.05, 0.05], priceInterval: 15, soc: 90, batCapacity: 5, net: net(lim),
  })).map((s) => s.power);
  assert.ok(plan(null)[0] < -1000);
  assert.ok(plan(7648)[0] >= -648, `${plan(7648)[0]}`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
