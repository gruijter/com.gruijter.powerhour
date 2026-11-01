/* eslint-disable no-console */

'use strict';

// Unit cases for the end of a program when the next one starts right after it (ApplianceModel
// processSample: restart after a short pause) and long runs left out of the profile.
// Run: node test/cases/appliance_restart.js

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

const MIN = 60 * 1000;
const START = new Date('2026-11-01T06:30:00+01:00').getTime();
const hhmm = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

// Washing machine on Prod, 1 Nov 2026 from 06:30, per 5 minutes (W): a wash 07:10-08:25, a
// pause of 10 minutes at standby, the next wash heating at 08:55.
const WASHES = [6, 6, 6, 6, 6, 6, 6, 18, 49, 1672, 480, 32, 32, 381, 60, 60, 28, 52, 37, 92, 102, 56, 60,
  87, 4, 5, 19, 54, 434, 2029, 2024, 2024, 2035, 2055, 2065, 1876, 64, 66, 72, 70, 64, 67, 73, 90, 93, 58,
  134, 62, 102, 102, 102, 102, 152, 47, 97];

// Replays values per step minutes (5) as a sample per minute; the events with their times.
const replay = (values, step = 5) => {
  let m = ApplianceModel.initModel();
  let meter = 100;
  const events = [];
  values.forEach((w, i) => {
    for (let k = 0; k < step; k += 1) {
      const t = START + (i * step + k) * MIN;
      meter += w / 60000;
      const r = ApplianceModel.processSample(m, {
        t, powerW: w, meterKwh: meter, timezone: TZ,
      });
      m = r.model;
      if (r.event) events.push({ event: r.event, t, run: r.run });
      if (r.restarted) events.push({ event: 'restarted', t, start: m.run.start });
    }
  });
  return { model: m, events };
};

test('two washes with a 10-minute pause: two runs', () => {
  const { model, events } = replay(WASHES);
  const finished = events.find((e) => e.event === 'finished');
  const restarted = events.find((e) => e.event === 'restarted');
  assert.ok(finished, 'first wash finished');
  assert.ok(restarted, 'second wash started');
  assert.strictEqual(hhmm(finished.run.start), '07:10');
  assert.strictEqual(hhmm(finished.run.end), '08:29');
  assert.strictEqual(hhmm(restarted.start), '08:40');
  assert.ok(model.run && model.run.start === restarted.start, 'second wash running');
  // The energy after the pause is in the second run, not the first.
  const kwh1 = finished.run.kwh.reduce((a, v) => a + v, 0);
  assert.ok(kwh1 > 0.2 && kwh1 < 0.4, `first wash ${kwh1.toFixed(3)} kWh`);
  const kwh2 = model.run.slots.reduce((a, v) => a + v, 0);
  assert.ok(kwh2 > 1.3, `second wash ${kwh2.toFixed(3)} kWh`);
});

test('a pause followed by a spin (below half the peak): one run', () => {
  const values = WASHES.slice(0, 26).map((w) => w); // up to the pause
  values.push(19, 300, 450, 300, 60, 6, 6, 6, 6, 6, 6, 6, 6);
  const { events } = replay(values);
  assert.ok(!events.some((e) => e.event === 'restarted'), 'no restart');
});

test('a short pause (3 minutes) with heating after it: one run', () => {
  const values = [6, 6, 1600, 1600, 400, 60, 60, 60, 4, 4, 4, 1800, 1800, 60];
  const { events } = replay(values, 1);
  assert.ok(!events.some((e) => e.event === 'restarted'), 'no restart');
});

test('profile leaves out a run far longer than the others', () => {
  const run = (startH, min) => ({ start: START + startH * 3600000, end: START + startH * 3600000 + min * MIN, kwh: new Array(Math.ceil(min / 15)).fill(0.1) });
  const model = { ...ApplianceModel.initModel(), runs: [run(0, 90), run(24, 85), run(48, 95), run(72, 240)] };
  const profile = ApplianceModel.getProfile(model);
  assert.strictEqual(profile.runs, 3);
  assert.strictEqual(profile.durationMin, 90);
});

test('profile keeps all runs when fewer than MIN_RUNS remain', () => {
  const run = (startH, min) => ({ start: START + startH * 3600000, end: START + startH * 3600000 + min * MIN, kwh: [0.1] });
  const model = { ...ApplianceModel.initModel(), runs: [run(0, 30), run(24, 30), run(48, 300)] };
  assert.strictEqual(ApplianceModel.getProfile(model).runs, 3);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
