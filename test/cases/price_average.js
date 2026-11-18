/* eslint-disable no-console */

'use strict';

// Unit cases for PriceProfile.addDailySums() / average(): the 4-week average of the price widget.
// Run: node test/cases/price_average.js

const assert = require('assert');
const PriceProfile = require('../../lib/strategies/PriceProfile');

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

const H = 3600000;
const now = Date.UTC(2026, 10, 18, 12);
const day = (date, n, price) => Array.from({ length: n }, (_, i) => ({ time: Date.UTC(2026, 10, date) + i * H, price }));

test('one day known: its average', () => {
  const p = PriceProfile.createProfile();
  PriceProfile.addDailySums(p, day(18, 24, 0.3), 'UTC', now);
  assert.ok(Math.abs(PriceProfile.average(p) - 0.3) < 1e-9);
});

test('forecast hours ahead count; gone again when no longer given', () => {
  const p = PriceProfile.createProfile();
  PriceProfile.addDailySums(p, day(18, 24, 0.2).concat(day(19, 24, 0.4)), 'UTC', now);
  assert.ok(Math.abs(PriceProfile.average(p) - 0.3) < 1e-9);
  PriceProfile.addDailySums(p, day(18, 24, 0.2), 'UTC', now);
  assert.ok(Math.abs(PriceProfile.average(p) - 0.2) < 1e-9);
});

test('today keeps its full hours when a later list starts at now', () => {
  const p = PriceProfile.createProfile();
  PriceProfile.addDailySums(p, day(18, 24, 0.2), 'UTC', now);
  PriceProfile.addDailySums(p, day(18, 24, 0.2).slice(12).concat(day(19, 24, 0.4)), 'UTC', now);
  assert.ok(Math.abs(PriceProfile.average(p) - 0.3) < 1e-9);
});

test('a past day keeps its full hours; at most 28 past days', () => {
  const p = PriceProfile.createProfile();
  PriceProfile.addDailySums(p, day(17, 24, 0.1), 'UTC', now);
  PriceProfile.addDailySums(p, day(17, 6, 0.9).concat(day(18, 24, 0.1)), 'UTC', now);
  assert.ok(Math.abs(PriceProfile.average(p) - 0.1) < 1e-9);
  const many = [];
  for (let d = 1; d <= 18; d += 1) many.push(...day(d, 24, 0.1));
  const q = PriceProfile.createProfile();
  q.dailySums = { '2026-09-01': [240, 24] };
  for (let i = 0; i < 30; i += 1) q.dailySums[`2026-10-${String(i + 1).padStart(2, '0')}`] = [2.4, 24];
  PriceProfile.addDailySums(q, many, 'UTC', now);
  assert.strictEqual(Object.keys(q.dailySums).length, 28);
  assert.ok(Math.abs(PriceProfile.average(q) - 0.1) < 1e-9);
});

if (failed) process.exitCode = 1;
