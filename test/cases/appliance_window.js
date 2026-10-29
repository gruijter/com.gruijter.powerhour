/* eslint-disable no-console */

'use strict';

// Unit cases for the start window of the flow card "Plan cheapest start between [from] and [to]"
// (ApplianceModel.startWindow). Run: node test/cases/appliance_window.js

const assert = require('assert');
const ApplianceModel = require('../../lib/strategies/ApplianceModel');

const TZ = 'Europe/Amsterdam';
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

// Local time in Amsterdam (CET, +01:00, in winter) as ms.
const at = (iso) => new Date(`${iso}+01:00`).getTime();
const window = (from, to, now) => {
  const w = ApplianceModel.startWindow(from, to, at(now), TZ);
  return { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString() };
};
const iso = (local) => new Date(at(local)).toISOString();

test('0-24: from now to midnight', () => {
  assert.deepStrictEqual(window(0, 24, '2026-11-10T20:00:00'), { from: iso('2026-11-10T20:00:00'), to: iso('2026-11-11T00:00:00') });
});

test('18-7 in the evening: from now over midnight', () => {
  assert.deepStrictEqual(window(18, 7, '2026-11-10T20:00:00'), { from: iso('2026-11-10T20:00:00'), to: iso('2026-11-11T07:00:00') });
});

test('18-7 after midnight: the window that started yesterday', () => {
  assert.deepStrictEqual(window(18, 7, '2026-11-11T02:00:00'), { from: iso('2026-11-11T02:00:00'), to: iso('2026-11-11T07:00:00') });
});

test('18-7 in the morning: tonight', () => {
  assert.deepStrictEqual(window(18, 7, '2026-11-11T10:00:00'), { from: iso('2026-11-11T18:00:00'), to: iso('2026-11-12T07:00:00') });
});

test('12-17 in the evening: tomorrow afternoon', () => {
  assert.deepStrictEqual(window(12, 17, '2026-11-10T20:00:00'), { from: iso('2026-11-11T12:00:00'), to: iso('2026-11-11T17:00:00') });
});

test('7.5-7.5: a whole day from 07:30, now still in yesterday\'s', () => {
  assert.deepStrictEqual(window(7.5, 7.5, '2026-11-10T06:00:00'), { from: iso('2026-11-10T06:00:00'), to: iso('2026-11-10T07:30:00') });
  assert.deepStrictEqual(window(7.5, 7.5, '2026-11-10T08:00:00'), { from: iso('2026-11-10T08:00:00'), to: iso('2026-11-11T07:30:00') });
});

test('over the DST change: 18-7 in local time', () => {
  // 25 Oct 2026: CEST to CET at 03:00.
  const w = ApplianceModel.startWindow(18, 7, new Date('2026-10-24T20:00:00+02:00').getTime(), TZ);
  assert.strictEqual(new Date(w.toMs).toISOString(), new Date('2026-10-25T07:00:00+01:00').toISOString());
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
