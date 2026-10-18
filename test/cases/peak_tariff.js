/* eslint-disable no-console */

'use strict';

// Unit cases for lib/strategies/PeakTariff.js. Run: node test/cases/peak_tariff.js

const assert = require('assert');
const P = require('../../lib/strategies/PeakTariff');

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

const cfg = (s) => P.configFromSettings({ peakPreset: 'custom', ...s });
const rec = (h, c, day, w) => P.recordWindow(h, c, { monthKey: '2026-10', dayKey: `2026-10-${day}`, weightedW: w });
const T = (h, c, day, fillW) => P.threshold(h, c, { monthKey: '2026-10', dayKey: `2026-10-${day}`, fillW });

test('parse hours', () => {
  assert.deepStrictEqual(P.parseHours('06-22'), { from: 6, to: 22 });
  assert.deepStrictEqual(P.parseHours('22-06'), { from: 22, to: 6 });
  assert.deepStrictEqual(P.parseHours('7:00-21:00'), { from: 7, to: 21 });
  assert.strictEqual(P.parseHours(''), null);
  assert.strictEqual(P.parseHours('6-6'), undefined);
  assert.strictEqual(P.parseHours('abc'), undefined);
});

test('parse months', () => {
  assert.deepStrictEqual([...P.parseMonths('11-3')].sort((a, b) => a - b), [1, 2, 3, 11, 12]);
  assert.deepStrictEqual([...P.parseMonths('1,2, 12')].sort((a, b) => a - b), [1, 2, 12]);
  assert.strictEqual(P.parseMonths('13'), undefined);
});

test('parse steps', () => {
  assert.deepStrictEqual(P.parseSteps('5:300; 2:190; 10 kW = 410'), [
    { toW: 2000, price: 190 }, { toW: 5000, price: 300 }, { toW: 10000, price: 410 }]);
  assert.deepStrictEqual(P.parseSteps('2,5:190'), [{ toW: 2500, price: 190 }]);
  assert.strictEqual(P.parseSteps('2-5:190'), undefined);
});

test('default config = old billed peak (max, minimum)', () => {
  const c = cfg({ peakMinimumW: 2500 });
  assert.strictEqual(T(null, c, '01').thresholdW, 2500);
  let h = rec(null, c, '01', 1800);
  assert.strictEqual(T(h, c, '02').thresholdW, 2500);
  h = rec(h, c, '02', 4100);
  assert.strictEqual(T(h, c, '03').thresholdW, 4100);
  assert.strictEqual(P.isActive(c), false);
});

test('no history, no minimum: no level', () => {
  assert.strictEqual(T(null, cfg({}), '01').thresholdW, null);
});

test('Norway: mean top-3 on different days, steps', () => {
  const c = cfg({
    peakSelection: 'mean', peakCount: 3, peakDistinctDays: true, peakSteps: '2:190; 5:300; 10:410; 15:600',
  });
  let h = rec(null, c, '01', 3000);
  h = rec(h, c, '01', 4000); // same day: daily max 4000
  h = rec(h, c, '02', 2000);
  h = rec(h, c, '03', 6000);
  // top-3 = 6000, 4000, 2000 → billed 4000 → step up to 5000; free up to sum 15000
  const t4 = T(h, c, '04');
  assert.strictEqual(t4.billedW, 4000);
  assert.strictEqual(t4.thresholdW, 15000 - 12000 + 2000); // 5000
  assert.strictEqual(t4.stepJump, 110);
  // On day 3 (6000 is today's own max): today can rise to 15000 - 12000 + 6000
  assert.strictEqual(T(h, c, '03').thresholdW, 9000);
});

test('Norway: start of month uses the fill', () => {
  const c = cfg({
    peakSelection: 'mean', peakCount: 3, peakDistinctDays: true, peakPrice: 50,
  });
  const h = rec(null, c, '01', 3000);
  assert.strictEqual(T(h, c, '02', 0).thresholdW, 0); // no fill: every watt counts
  assert.strictEqual(T(h, c, '02', 2500).thresholdW, 2500); // fill: free up to the expected 3rd
  assert.ok(Math.abs(T(h, c, '02', 2500).penaltyPerKw - 50 / 3) < 1e-9);
});

test('mean top-N without different days', () => {
  const c = cfg({ peakSelection: 'mean', peakCount: 2, peakPrice: 10 });
  let h = rec(null, c, '01', 3000);
  h = rec(h, c, '01', 5000);
  h = rec(h, c, '01', 1000);
  assert.strictEqual(T(h, c, '01').thresholdW, 3000);
});

test('N-th highest (11th)', () => {
  const c = cfg({ peakSelection: 'nth', peakCount: 11, peakPrice: 4 });
  let h = null;
  for (let i = 1; i <= 12; i += 1) h = rec(h, c, '01', i * 100);
  assert.strictEqual(T(h, c, '01').thresholdW, 200);
  assert.strictEqual(P.billedW(h, c, '2026-10'), 200);
});

test('weighting: night counts half, outside months not', () => {
  const c = cfg({ peakHours: '06-22', peakMonths: '11-3', peakWeightOutside: 0.5 });
  assert.strictEqual(P.weightAt(c, new Date(2026, 0, 5, 12)), 1);
  assert.strictEqual(P.weightAt(c, new Date(2026, 0, 5, 23)), 0.5);
  assert.strictEqual(P.weightAt(c, new Date(2026, 6, 5, 12)), 0.5);
  const w = cfg({ peakHours: '07-21', peakWeekdaysOnly: true, peakWeightOutside: 0 });
  assert.strictEqual(P.weightAt(w, new Date(2026, 9, 10, 12)), 0); // Saturday
  assert.strictEqual(P.weightAt(w, new Date(2026, 9, 12, 12)), 1); // Monday
});

test('last step: no level above it', () => {
  const c = cfg({ peakSteps: '2:100; 5:200' });
  const h = rec(null, c, '01', 6000);
  assert.strictEqual(T(h, c, '02').thresholdW, Infinity);
});

test('history resets on a new month or other weighting', () => {
  const c = cfg({});
  const h = rec(null, c, '01', 3000);
  const next = P.recordWindow(h, c, { monthKey: '2026-11', dayKey: '2026-11-01', weightedW: 100 });
  assert.deepStrictEqual(next.top, [100]);
  const c2 = cfg({ peakHours: '06-22' });
  assert.deepStrictEqual(rec(h, c2, '01', 50).top, [50]);
});

test('nth per day: today above the N-th is free', () => {
  const c = cfg({
    peakSelection: 'nth', peakCount: 3, peakDistinctDays: true, peakPrice: 5,
  });
  let h = null;
  [['01', 3000], ['02', 2800], ['03', 2600], ['04', 5000]].forEach(([d, w]) => {
    h = rec(h, c, d, w);
  });
  assert.strictEqual(T(h, c, '04').thresholdW, Infinity);
  assert.strictEqual(T(h, c, '02').thresholdW, 2800);
  assert.strictEqual(T(h, c, '05').thresholdW, 2800);
});

test('presets only write tariff keys', () => {
  Object.values(P.PRESETS).forEach((p) => Object.keys(p).forEach((k) => assert.ok(P.TARIFF_KEYS.includes(k), k)));
  assert.strictEqual(P.isActive(cfg({ peakPreset: 'norway' })), true);
});

test('invalid settings', () => {
  assert.strictEqual(P.invalidReason({ peakHours: '25-3' }), 'error_peak_hours');
  assert.strictEqual(P.invalidReason({ peakSteps: 'x' }), 'error_peak_steps');
  assert.strictEqual(P.invalidReason({}), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
