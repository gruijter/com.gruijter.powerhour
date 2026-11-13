/* eslint-disable no-console */

'use strict';

// Unit cases for the sun position (ClearSkyGHI, NOAA formula) and the eclipse search
// (SolarEclipse, astronomy-engine loaded for the search only). Run: node test/cases/solar_astro.js

const assert = require('assert');
const { estimateClearSkyGHI } = require('../../lib/helpers/ClearSkyGHI');
const SolarEclipse = require('../../lib/helpers/SolarEclipse');

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

const LAT = 52.09;
const LON = 5.12;
const loaded = () => Object.keys(require.cache).some((k) => k.includes('astronomy-engine'));

test('clear sky: zero at night, near the astronomy-engine values by day', () => {
  assert.strictEqual(estimateClearSkyGHI(Date.parse('2026-06-21T23:00:00Z'), LAT, LON), 0);
  // astronomy-engine gave 901.0 (summer noon) and 217.5 W/m2 (winter noon) here.
  assert.ok(Math.abs(estimateClearSkyGHI(Date.parse('2026-06-21T11:40:00Z'), LAT, LON) - 901.0) < 3);
  assert.ok(Math.abs(estimateClearSkyGHI(Date.parse('2026-12-21T11:45:00Z'), LAT, LON) - 217.5) < 3);
});

test('eclipse of 12 Aug 2026 found, the library released after the search', () => {
  const e = SolarEclipse.findNext(new Date('2026-08-01T00:00:00Z'), LAT, LON);
  assert.strictEqual(new Date(e.peak).toISOString().slice(0, 13), '2026-08-12T18');
  assert.ok(e.obscuration > 0.8 && e.obscuration < 0.95);
  assert.strictEqual(loaded(), false);
});

test('one search a day per location, shared by devices', () => {
  const now = Date.parse('2026-08-05T00:00:00Z');
  const a = SolarEclipse.findNextShared(now, LAT, LON);
  const b = SolarEclipse.findNextShared(now + 6 * 3600 * 1000, LAT, LON);
  assert.strictEqual(a, b);
  const c = SolarEclipse.findNextShared(now + 25 * 3600 * 1000, LAT, LON);
  assert.notStrictEqual(a, c);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
