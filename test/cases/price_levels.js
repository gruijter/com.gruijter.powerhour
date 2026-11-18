/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/PriceLevels.js: cheapest/dearest hours per day, free, flat day.
// Run: node test/cases/price_levels.js

const assert = require('assert');
const PriceLevels = require('../../lib/helpers/PriceLevels');

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
const day0 = Date.UTC(2026, 10, 18);
const hours = (start, prices) => prices.map((price, i) => ({ t: start + i * H, price }));
const at = (map, start, i) => map.get(start + i * H);

test('per day the n cheapest and dearest hours', () => {
  const prices = Array.from({ length: 24 }, (_, i) => 0.2 + i / 100);
  const m = PriceLevels.levels(hours(day0, prices), 60, 4, 'UTC');
  assert.deepStrictEqual([0, 3, 4, 19, 20, 23].map((i) => at(m, day0, i)), ['cheap', 'cheap', 'normal', 'normal', 'dear', 'dear']);
});

test('each day on its own', () => {
  const low = Array.from({ length: 24 }, (_, i) => 0.1 + i / 1000);
  const high = Array.from({ length: 24 }, (_, i) => 1 + i / 100);
  const m = PriceLevels.levels(hours(day0, low).concat(hours(day0 + 24 * H, high)), 60, 2, 'UTC');
  assert.strictEqual(at(m, day0, 23), 'dear');
  assert.strictEqual(at(m, day0 + 24 * H, 0), 'cheap');
});

test('free at 0 or less; flat day normal; 15 minute slots', () => {
  const free = Array.from({ length: 96 }, (_, i) => (i === 10 ? -0.01 : 0.3 + i / 1000));
  assert.strictEqual(PriceLevels.levels(free.map((price, i) => ({ t: day0 + i * 900000, price })), 15, 4, 'UTC').get(day0 + 10 * 900000), 'free');
  const flat = Array.from({ length: 96 }, (_, i) => 0.3 + (i % 2) / 1000);
  const m = PriceLevels.levels(flat.map((price, i) => ({ t: day0 + i * 900000, price })), 15, 4, 'UTC');
  assert.strictEqual(m.get(day0), 'normal');
  const steps = Array.from({ length: 96 }, (_, i) => 0.2 + i / 1000);
  const q = PriceLevels.levels(steps.map((price, i) => ({ t: day0 + i * 900000, price })), 15, 1, 'UTC');
  assert.strictEqual(q.get(day0 + 3 * 900000), 'cheap');
  assert.strictEqual(q.get(day0 + 4 * 900000), 'normal');
});

test('0 hours: no cheap or dear', () => {
  const prices = Array.from({ length: 24 }, (_, i) => 0.2 + i / 100);
  const m = PriceLevels.levels(hours(day0, prices), 60, 0, 'UTC');
  assert.ok([...m.values()].every((v) => v === 'normal'));
});

if (failed) process.exitCode = 1;
