/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/BatteryControl.js. Run: node test/cases/battery_control.js

const assert = require('assert');
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

const now = Date.UTC(2026, 9, 11, 12, 5);
const base = {
  now, socPct: 50, capacityKwh: 5, maxChargeW: 2200, maxDischargeW: 1700,
};
const slot = (block, soc) => ({
  block, soc, index: 0, endMs: Date.UTC(2026, 9, 11, 12, 15),
});

test('zero: absorbs export, covers import', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('zero', 60), gridW: -800, batteryW: 0,
  }).powerW, 400);
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('zero', 40), gridW: 300, batteryW: -200,
  }).powerW, -350);
});

// Learned settings with a 50 W fixed loss: a small charge waits, then runs at the efficient power.
test('pulse: charge/discharge block below the efficient power', () => {
  const loss = (p) => Math.round(((50 + (2e-5 * p * p)) / p) * 10000) / 100;
  const learned = {
    chargePower: 2200,
    chargeLoss: loss(2200),
    chargePowerEff: 1500,
    chargeLossEff: loss(1500),
    chargePower3: 1850,
    chargeLoss3: loss(1850),
    dischargePower: 1700,
    dischargeLoss: loss(1700),
    dischargePowerEff: 1300,
    dischargeLossEff: loss(1300),
    dischargePower3: 1500,
    dischargeLoss3: loss(1500),
  };
  const pulse = C.pulseParams(learned);
  const waiting = { pulseWait: 'charge' };
  assert.strictEqual(pulse.chargeW, 1500);
  assert.ok(Math.abs(pulse.overheadWh - 1.125) < 0.01, `overhead ${pulse.overheadWh}`);
  const o = {
    ...base, mode: 'smart', gridW: 0, batteryW: 0, pulse,
  };
  // 10 min left, 50 -> 52 %: 100 Wh, 600 W on average.
  const wait = C.decide({ ...o, slot: slot('charge', 52) });
  assert.strictEqual(wait.powerW, 0, 'waits');
  assert.strictEqual(wait.state.pulseOn, false);
  assert.strictEqual(wait.state.pulseWait, 'charge');
  const late = { ...o, now: Date.UTC(2026, 9, 11, 12, 11) }; // 4 min left: 1500 W needed
  assert.strictEqual(C.decide({ ...late, slot: slot('charge', 52) }).state.pulseOn, false, 'not waited: a plain charge');
  const run = C.decide({ ...late, slot: slot('charge', 52), state: waiting });
  assert.strictEqual(run.powerW, 1500, 'runs at the efficient power');
  assert.strictEqual(run.state.pulseOn, 'charge');
  const on = C.decide({ ...o, slot: slot('charge', 52), state: run.state });
  assert.strictEqual(on.powerW, 1500, 'keeps running until the target');
  assert.strictEqual(C.decide({
    ...o, socPct: 52, slot: slot('charge', 52), state: run.state,
  }).state.pulseOn, false, 'ends at the target');
  assert.strictEqual(C.decide({ ...o, slot: slot('discharge', 48) }).powerW, 0, 'discharge waits too');
  assert.strictEqual(C.decide({ ...o, slot: slot('charge', 52), pulse: null }).powerW, 600, 'without: steady');
  const flat = C.pulseParams({
    chargePower: 2200, chargeLoss: 10, chargePowerEff: 1050, chargeLossEff: 5, chargePower3: 1791, chargeLoss3: 7,
  });
  assert.strictEqual(C.decide({ ...o, slot: slot('charge', 52), pulse: flat }).powerW, 600, 'no fixed loss: steady');
  const tiny = C.decide({ ...o, now: Date.UTC(2026, 9, 11, 12, 14, 30), slot: slot('charge', 50.1) });
  assert.ok(tiny.powerW > 0 && !tiny.state.pulseOn, `a few Wh: not worth a start (${tiny.powerW} W)`);
});

test('zero: limited by max power', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('zero', 60), gridW: -5000, batteryW: 0,
  }).powerW, 2200);
});

test('low-power threshold with hysteresis', () => {
  const o = {
    ...base, mode: 'smart', slot: slot('zero', 40), minDischargeW: 400,
  };
  let r = C.decide({ ...o, gridW: 250, batteryW: 0 });
  assert.strictEqual(r.powerW, 0, 'night 250 W: grid');
  r = C.decide({
    ...o, gridW: 600, batteryW: 0, state: r.state,
  });
  assert.strictEqual(r.powerW, -300, 'kettle: battery (half step)');
  // Back to 300 W: stays on (above 0.8 x 400 on the average) ...
  r = C.decide({
    ...o, gridW: 300, batteryW: -600, avgZeroW: -500, state: r.state,
  });
  assert.strictEqual(r.powerW, -750);
  // ... until the average is under 320 W for 2 minutes.
  r = C.decide({
    ...o, gridW: 0, batteryW: -250, avgZeroW: -250, state: r.state,
  });
  assert.strictEqual(r.powerW, -250, 'still on within 2 min');
  r = C.decide({
    ...o, now: now + C.STOP_AFTER_MS, gridW: 0, batteryW: -250, avgZeroW: -250, state: r.state,
  });
  assert.strictEqual(r.powerW, 0, 'off after 2 min');
});

test('zero covering the deficit in part: at most the planned power (smart only)', () => {
  const part = { ...slot('zero', 40), homeCapW: 250 };
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: part, gridW: 300, batteryW: -200,
  }).powerW, -250, 'capped');
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: part, gridW: -800, batteryW: 0,
  }).powerW, 400, 'surplus not capped');
  assert.strictEqual(C.decide({
    ...base, mode: 'self_consumption', slot: part, gridW: 300, batteryW: -200,
  }).powerW, -350, 'self-consumption: whole deficit');
  assert.strictEqual(C.blockFor('smart', { ...slot('hold', 40), homeCapW: 250 }).homeCapW, undefined, 'only on zero');
});

test('hold: no discharge, surplus charges', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('hold', 50), gridW: 700, batteryW: 0,
  }).powerW, 0);
  assert.strictEqual(C.decide({
    ...base, mode: 'hold', slot: null, gridW: -700, batteryW: 0,
  }).powerW, 350);
});

test('charge block: toward the SoC target by the slot end', () => {
  // 50 -> 60 % of 5 kWh = 0.5 kWh in 10 min = 3000 W, capped at 2200.
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('charge', 60), gridW: 500, batteryW: 0,
  }).powerW, 2200);
  // 50 -> 52 %: 0.1 kWh in 10 min = 600 W.
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('charge', 52), gridW: 500, batteryW: 0,
  }).powerW, 600);
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('charge', 50), gridW: 500, batteryW: 0,
  }).powerW, 0, 'target reached');
});

test('discharge mode: full power', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'discharge', slot: null, gridW: 0, batteryW: 0,
  }).powerW, -1700);
});

test('import limit caps charging and forces discharge', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'charge', slot: null, gridW: 3000, batteryW: 1000, maxW: 1400,
  }).powerW, 1400);
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('idle', 50), gridW: 6000, batteryW: 0, maxW: -1000,
  }).powerW, -1000);
});

test('device mode releases', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'device', slot: null, gridW: 0, batteryW: 0,
  }).release, true);
});

test('two batteries share the grid correction', () => {
  assert.strictEqual(C.decide({
    ...base, mode: 'smart', slot: slot('zero', 60), gridW: -1000, batteryW: 0, share: 0.5,
  }).powerW, 250);
});

test('zero converges to grid 0 with a one-tick lag of the grid reading', () => {
  // Home load 2000 W; the grid reading reflects the setpoint of the previous tick.
  let setW = 0;
  let prevSetW = 0;
  for (let i = 0; i < 12; i += 1) {
    const gridW = 2000 + prevSetW;
    prevSetW = setW;
    setW = C.decide({
      ...base, maxDischargeW: 3000, mode: 'smart', slot: slot('zero', 40), gridW, batteryW: setW,
    }).powerW;
  }
  assert.ok(Math.abs(setW + 2000) <= 60, `ends at ${setW} W`);
});

test('write: on change, to 0, keepalive', () => {
  assert.ok(C.shouldWrite({ powerW: 100, lastW: null, now }));
  assert.ok(!C.shouldWrite({
    powerW: 120, lastW: 100, lastTm: now - 5000, now,
  }));
  assert.ok(C.shouldWrite({
    powerW: 0, lastW: 20, lastTm: now - 5000, now,
  }));
  assert.ok(C.shouldWrite({
    powerW: 120, lastW: 100, lastTm: now - 61000, now,
  }));
});

test('slotAt and plan options', () => {
  const plan = { startMs: now - 300000, intervalMs: 900000, slots: [{ block: 'zero', soc: 55 }, { block: 'hold', soc: 55 }] };
  assert.strictEqual(C.slotAt(plan, now).block, 'zero');
  assert.strictEqual(C.slotAt(plan, now + 900000).block, 'hold');
  assert.strictEqual(C.slotAt(plan, now + 2000000), null);
  assert.deepStrictEqual(C.planOptionsFor('self_consumption'), { allowGridCharge: false, allowExport: false, minimizeGrid: true });
});

test('peak shaving in an idle block: discharges to stay under the limit', () => {
  const r = C.decide({
    ...base, mode: 'smart', slot: slot('idle', 50), gridW: 3000, batteryW: 0, maxW: -800,
  });
  assert.strictEqual(r.block, 'idle');
  assert.strictEqual(r.powerW, -800);
});

test('reserve: no discharge below it, except for the import limit', () => {
  const o = {
    ...base, socPct: 20, minSocPct: 20, mode: 'smart', slot: slot('zero', 20), gridW: 500, batteryW: 0,
  };
  assert.strictEqual(C.decide(o).powerW, 0);
  assert.strictEqual(C.decide({ ...o, mode: 'discharge' }).powerW, 0);
  assert.strictEqual(C.decide({ ...o, maxW: -600 }).powerW, -600);
  assert.strictEqual(C.decide({ ...o, maxW: -600, reserveForPeak: false }).powerW, 0, 'without peak shaving the reserve stays');
  assert.strictEqual(C.decide({
    ...o, maxW: -600, hardMaxW: -250, reserveForPeak: false,
  }).powerW, -250, 'the hard limit (fuse, contract) may use the reserve');
  assert.strictEqual(C.decide({
    ...o, socPct: 30, maxW: -600, reserveForPeak: false,
  }).powerW, -600, 'above the reserve the limit applies');
  assert.strictEqual(C.decide({ ...o, socPct: 12 }).powerW, 2200, 'below the reserve: refill at full power');
  assert.strictEqual(C.decide({ ...o, socPct: 12, maxW: 700 }).powerW, 700, 'refill within the import headroom');
  assert.strictEqual(C.decide({ ...o, socPct: 12, mode: 'discharge' }).powerW, 2200, 'also in discharge mode');
  assert.ok(C.decide({ ...o, socPct: 30 }).powerW < 0, 'above the reserve it discharges');
  assert.strictEqual(C.decide({ ...o, gridW: -500 }).powerW, 250, 'charging is not limited');
});

test('self-consumption: idle is zero on the meter, the reserve is not refilled from the grid', () => {
  const o = {
    ...base, socPct: 50, mode: 'self_consumption', slot: slot('idle', 50), gridW: -500, batteryW: 0,
  };
  assert.strictEqual(C.decide(o).block, 'zero');
  assert.strictEqual(C.decide(o).powerW, 250, 'an unforeseen surplus charges');
  assert.strictEqual(C.decide({ ...o, mode: 'smart' }).powerW, 0, 'smart keeps the idle block');
  const r = { ...o, socPct: 12, minSocPct: 20 };
  assert.strictEqual(C.decide({ ...r, gridW: 500 }).powerW, 0, 'below the reserve: no grid charge, no discharge');
  assert.strictEqual(C.decide({ ...r, gridW: -500 }).powerW, 250, 'below the reserve: surplus charges');
  assert.strictEqual(C.refillsReserve('self_consumption'), false);
  assert.strictEqual(C.refillsReserve('smart'), true);
});

test('xom: zero on the meter whatever the plan, the reserve not refilled from the grid', () => {
  const o = {
    ...base, socPct: 50, mode: 'xom', gridW: 600, batteryW: 0,
  };
  ['idle', 'hold', 'charge', 'discharge'].forEach((b) => {
    assert.strictEqual(C.decide({ ...o, slot: slot(b, 90) }).block, 'zero', `plan ${b}`);
    assert.strictEqual(C.decide({ ...o, slot: { ...slot(b, 90), noCharge: true }, gridW: -600 }).powerW, 300, `plan ${b}: surplus charges`);
  });
  assert.strictEqual(C.decide({ ...o, slot: slot('charge', 90) }).powerW, -300, 'deficit covered');
  const r = {
    ...o, slot: slot('idle', 50), socPct: 12, minSocPct: 20,
  };
  assert.strictEqual(C.decide(r).powerW, 0, 'below the reserve: no grid charge, no discharge');
  assert.strictEqual(C.decide({ ...r, gridW: -500 }).powerW, 250, 'below the reserve: surplus charges');
  assert.deepStrictEqual(C.planOptionsFor('xom'), C.planOptionsFor('self_consumption'), 'planned as self-consumption');
  assert.ok(C.MODES.includes('xom'));
});

test('idle: nothing, whatever the plan, no reserve refill, no plan', () => {
  const o = {
    ...base, socPct: 50, mode: 'idle', gridW: 600, batteryW: 0,
  };
  ['zero', 'charge', 'discharge', 'hold'].forEach((b) => {
    assert.strictEqual(C.decide({ ...o, slot: slot(b, 90) }).powerW, 0, `plan ${b}`);
    assert.strictEqual(C.decide({ ...o, slot: slot(b, 90), gridW: -800 }).powerW, 0, `plan ${b}, surplus`);
  });
  assert.strictEqual(C.decide({
    ...o, slot: slot('idle', 50), socPct: 5, minSocPct: 20,
  }).powerW, 0, 'below the reserve: no refill');
  assert.strictEqual(C.refillsReserve('idle'), false);
  assert.ok(C.planOptionsFor('idle').idle);
  const light = require('../../lib/strategies/LightPlanner');
  const plans = light.idleStrategy({
    prices: [0.2, 0.3, 0.25], priceInterval: 15, batteries: [{ soc: 40 }, { soc: 70 }],
  });
  assert.deepStrictEqual(plans.map((p) => [Object.keys(p).length, p[2].block, p[2].power, p[2].soc]), [[3, 'idle', 0, 40], [3, 'idle', 0, 70]]);
});

test('self-consumption, noCharge (wear): no surplus taken, the deficit still covered', () => {
  const o = {
    ...base, socPct: 50, mode: 'self_consumption', slot: { ...slot('idle', 50), noCharge: true }, gridW: -500, batteryW: 0,
  };
  assert.strictEqual(C.decide(o).powerW, 0, 'surplus not stored');
  assert.strictEqual(C.decide({ ...o, gridW: 500 }).powerW, -250, 'stored energy covers the deficit');
  assert.strictEqual(C.decide({ ...o, mode: 'smart', slot: { ...slot('zero', 50), noCharge: true } }).powerW, 0, 'smart: noCharge too');
  assert.strictEqual(C.decide({ ...o, mode: 'smart', slot: { ...slot('hold', 50), minSolarW: 400 } }).powerW, 250, 'minSolarW: 500 W surplus stored');
  assert.strictEqual(C.decide({ ...o, mode: 'smart', slot: { ...slot('hold', 50), minSolarW: 600 } }).powerW, 0, 'minSolarW: 500 W surplus left');
});

test('followCap: a battery not doing its setpoint is capped near what it does, raised while it follows', () => {
  const t0 = 1e9;
  const o = {
    cap: null, lagSince: null, setW: -1320, setTm: t0, maxW: 1650,
  };
  let f = C.followCap({ ...o, actW: -717, now: t0 + 5000 });
  assert.strictEqual(f.cap, null, 'settling after the write');
  f = C.followCap({ ...o, actW: -717, now: t0 + 12000 });
  assert.ok(f.cap === null && f.lagSince === t0 + 12000, 'lag starts');
  f = C.followCap({
    ...o, ...f, actW: -717, now: t0 + 60000,
  });
  assert.strictEqual(f.cap, null, 'a minute: may still be starting');
  f = C.followCap({
    ...o, ...f, actW: -717, now: t0 + 88000,
  });
  assert.deepStrictEqual(f.cap, { dir: -1, w: 817 }, 'capped after 75 s');
  f = C.followCap({
    ...o, ...f, setW: -817, actW: -717, now: t0 + 100000,
  });
  assert.deepStrictEqual(f.cap, { dir: -1, w: 817 }, 'stuck: cap kept');
  f = C.followCap({
    ...o, ...f, setW: -817, actW: -800, now: t0 + 105000,
  });
  assert.deepStrictEqual(f.cap, { dir: -1, w: 917 }, 'reaches it: raised');
  assert.strictEqual(C.followCap({
    ...o, ...f, cap: { dir: -1, w: 1600 }, setW: -1600, actW: -1590, now: t0 + 110000,
  }).cap, null, 'up to its max: released');
  assert.strictEqual(C.followCap({
    ...o, ...f, setW: 500, actW: 500, now: t0 + 50000,
  }).cap, null, 'other direction: none');
  assert.strictEqual(C.followCap({ ...o, actW: -1300, now: t0 + 30000 }).cap, null, 'following: none');
});

test('leadLimitW: the integrator at most 30 % of max power (300 W min.) ahead of a fast reporter', () => {
  const o = { maxChargeW: 2200, maxDischargeW: 1650, reportMs: 8000 };
  assert.strictEqual(C.leadLimitW({ ...o, cmdW: -1650, actW: 0 }), -495, 'starting: held near what it does');
  assert.strictEqual(C.leadLimitW({ ...o, cmdW: -1600, actW: -1520 }), -1600, 'following: unchanged');
  assert.strictEqual(C.leadLimitW({ ...o, cmdW: 2000, actW: 0 }), 660, 'charging: 30 % of 2200');
  assert.strictEqual(C.leadLimitW({
    ...o, maxDischargeW: 500, cmdW: -500, actW: 0,
  }), -300, 'at least 300 W');
  assert.strictEqual(C.leadLimitW({
    ...o, reportMs: 60000, cmdW: -1650, actW: 0,
  }), -1650, 'slow reporter: not limited');
  assert.strictEqual(C.leadLimitW({
    ...o, reportMs: undefined, cmdW: -1650, actW: 0,
  }), -1650, 'unknown: not limited');
});

test('nomStep: short spikes left to the grid, less at once, small changes by GAIN', () => {
  const t = 1e9;
  assert.deepStrictEqual(C.nomStep({ prevW: null, targetW: -800, now: t }), { w: -800, riseSince: null }, 'entering: at once');
  let r = C.nomStep({
    prevW: -100, targetW: -2400, riseSince: null, now: t,
  });
  assert.deepStrictEqual(r, { w: -100, riseSince: t }, 'spike: held');
  r = C.nomStep({
    prevW: -100, targetW: -2400, riseSince: r.riseSince, now: t + 15000,
  });
  assert.strictEqual(r.w, -100, 'still held after 15 s');
  r = C.nomStep({
    prevW: -100, targetW: -2400, riseSince: r.riseSince, now: t + 20000,
  });
  assert.strictEqual(r.w, -1250, 'lasted 20 s: toward it by GAIN');
  assert.deepStrictEqual(C.nomStep({
    prevW: -100, targetW: -110, riseSince: t, now: t + 1000,
  }), { w: -105, riseSince: null }, 'spike gone: reset');
  assert.strictEqual(C.nomStep({ prevW: -1500, targetW: -300, now: t }).w, -300, 'less: at once');
  assert.strictEqual(C.nomStep({ prevW: -500, targetW: -600, now: t }).w, -550, 'small change: GAIN');
  assert.strictEqual(C.nomStep({ prevW: -800, targetW: 900, now: t }).w, 0, 'other way: to 0 at once, charging waits');
  assert.strictEqual(C.nomStep({ prevW: -800, targetW: 150, now: t }).w, 75, 'other way, small: GAIN from 0');
});

test('actionFor: one word per block, refill and no control', () => {
  assert.deepStrictEqual(['zero', 'hold', 'idle', 'charge', 'discharge'].map((block) => C.actionFor({ block })), ['nom', 'save', 'rest', 'charge', 'discharge']);
  assert.strictEqual(C.actionFor({ block: 'zero', refill: true }), 'refill');
  assert.strictEqual(C.actionFor(), 'none');
});

test('shouldWrite: finer steps in zero on the meter', () => {
  const w = { lastW: -1200, lastTm: 1, now: 2 };
  assert.ok(C.shouldWrite({ ...w, powerW: -1230, block: 'zero' }));
  assert.ok(!C.shouldWrite({ ...w, powerW: -1230, block: 'discharge' }));
});

test('BatteryResponse: time to 90 % of a setpoint step, from standstill and running', () => {
  const R = require('../../lib/strategies/BatteryResponse');
  const t = 1e9;
  let st = R.onWrite(R.createState(), { now: t, setW: 2200, actW: 3 });
  assert.ok(st.step && st.step.standstill, 'step from standstill');
  let r = R.onReport(st, { now: t + 30000, actW: 1500 });
  assert.strictEqual(r.sample, null, '68 %: not yet');
  st = R.onWrite(r.state, { now: t + 32000, setW: 2180, actW: 1500 });
  assert.strictEqual(st.step.tm, t, 'a further write the same way keeps the start');
  r = R.onReport(st, { now: t + 45000, actW: 2000 });
  assert.deepStrictEqual([r.sample.kind, r.sample.ms], ['standstill', 45000]);
  assert.deepStrictEqual(r.state.standstill, { ms: 45000, n: 1 });
  st = R.onWrite(r.state, { now: t + 60000, setW: 1500, actW: 2000 });
  r = R.onReport(st, { now: t + 70000, actW: 1540 });
  assert.deepStrictEqual([r.sample.kind, r.sample.ms], ['running', 10000]);
  st = R.onWrite(r.state, { now: t + 80000, setW: 1600, actW: 1540 });
  assert.strictEqual(st.step, null, 'small step: no sample');
  st = R.onWrite(st, { now: t + 80000, setW: -800, actW: 1540 });
  r = R.onReport(st, { now: t + 80000 + (4 * 60000), actW: 1540 });
  assert.ok(r.sample === null && r.state.step === null, 'never reached: dropped');
  assert.ok(/standstill 45.0 s \(n 1\), running 10.0 s \(n 1\)/.test(R.describe(r.state)), R.describe(r.state));
});

// NomXomStrategy (zero on the meter over a group): BatterySplit, efficiency first, then SoC.
const nom = require('../../lib/strategies/NomXomStrategy');

const sessySettings = {
  chargePower: 2200, chargeLoss: 10, chargePowerEff: 1050, chargeLossEff: 5, dischargePower: 1700, dischargeLoss: 8, dischargePowerEff: 800, dischargeLossEff: 4,
};
const nomDev = (id, soc, settings = sessySettings, reserve = 0) => ({
  getData: () => ({ id }), getName: () => id, getSettings: () => settings, getCapabilityValue: () => 0, soc, xomTargetPower: 0, reservePct: () => reserve,
});
const nomW = (devices, gridW) => {
  const st = nom.getStrategy({
    devices, cumulativePower: gridW, x: 0, minLoad: 50,
  });
  return devices.map((d) => Math.round(st.find((s) => s.id === d.getData().id).target));
};

test('NomXom: fewest batteries within their efficient power, then by SoC', () => {
  assert.deepStrictEqual(nomW([nomDev('a', 50), nomDev('b', 48)], 300), [-300, 0], 'small deficit: fullest alone');
  assert.deepStrictEqual(nomW([nomDev('a', 80), nomDev('b', 20)], 1600), [-800, -800], 'not one at 1600 W');
  assert.deepStrictEqual(nomW([nomDev('a', 80), nomDev('b', 20)], -1600), [550, 1050], 'charge: emptiest to its efficient power first');
  assert.deepStrictEqual(nomW([nomDev('a', 50), nomDev('b', 20, sessySettings, 20)], 600), [-600, 0], 'at its reserve: nothing');
  assert.deepStrictEqual(nomW([nomDev('a', 100), nomDev('b', 30)], -600), [0, 600], 'full: no charge');
  const capped = nomDev('b', 48);
  capped.capW = { dir: -1, w: 700 };
  assert.deepStrictEqual(nomW([nomDev('a', 50), capped], 2400), [-1700, -700], 'a capped battery: the other takes the rest');
  const better = { ...sessySettings, dischargeLossEff: 2 };
  assert.deepStrictEqual(nomW([nomDev('a', 80), nomDev('b', 40, better)], 600), [0, -600], 'most efficient first');
});

test('NomXom: no flip-flopping at the efficient power', () => {
  const devs = [nomDev('a', 50), nomDev('b', 48)];
  let changes = 0;
  let prev = '';
  for (let i = 0; i < 60; i += 1) {
    const load = 860 + (90 * Math.sin(i * 1.3)) + ((i % 5) * 10);
    const gridW = load + devs.reduce((a, d) => a + d.xomTargetPower, 0);
    const w = nomW(devs, gridW);
    devs.forEach((d, k) => {
      d.xomTargetPower = w[k];
    });
    const set = w.map((v) => (Math.abs(v) > 10 ? 1 : 0)).join('');
    if (set !== prev) changes += 1;
    prev = set;
  }
  assert.ok(changes <= 2, `${changes} changes`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
