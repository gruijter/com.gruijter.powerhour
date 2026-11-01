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

test('profile keeps long runs that are a program of their own', () => {
  const run = (i, min) => ({ start: START + i * 86400000, end: START + i * 86400000 + min * MIN, kwh: new Array(Math.ceil(min / 15)).fill(0.1) });
  const runs = [...Array.from({ length: 12 }, (_, i) => run(i, 30)), ...Array.from({ length: 8 }, (_, i) => run(12 + i, 180))];
  const profile = ApplianceModel.getProfile({ ...ApplianceModel.initModel(), runs });
  assert.strictEqual(profile.runs, 20);
  assert.strictEqual(profile.shortestMin, 30);
});

test('profile keeps all runs when fewer than MIN_RUNS remain', () => {
  const run = (startH, min) => ({ start: START + startH * 3600000, end: START + startH * 3600000 + min * MIN, kwh: [0.1] });
  const model = { ...ApplianceModel.initModel(), runs: [run(0, 30), run(24, 30), run(48, 300)] };
  assert.strictEqual(ApplianceModel.getProfile(model).runs, 3);
});

// The same day per minute from 06:50 (W): dips inside the first wash of at most a few minutes
// (8 and 6 W at 07:49), the pause of ~10 minutes, the second wash ending at 11:13.
const MINUTES = [
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 28, 41,
  46, 48, 58, 42, 52, 549, 2053, 2026, 2014, 1720, 48, 38, 753, 1523, 40, 47, 22, 12, 28, 50,
  40, 17, 16, 35, 51, 1503, 224, 58, 58, 61, 61, 60, 61, 58, 59, 58, 52, 41, 65, 84,
  8, 6, 21, 52, 52, 55, 44, 59, 41, 60, 25, 17, 45, 47, 50, 72, 155, 127, 38, 69,
  79, 69, 68, 126, 167, 41, 45, 66, 67, 59, 43, 52, 44, 51, 109, 174, 163, 77, 16, 4,
  4, 4, 4, 6, 6, 6, 6, 6, 4, 3, 3, 21, 27, 24, 18, 49, 46, 71, 62, 41,
  78, 48, 81, 84, 1879, 2022, 2028, 2031, 2034, 2033, 2028, 2022, 2029, 2024, 2017, 2018, 2004, 2017, 2033, 2047,
  2032, 2032, 2033, 2037, 2042, 2030, 2021, 2057, 2084, 2081, 2073, 2062, 2057, 2070, 2063, 2062, 2071, 2063, 2086, 1100,
  44, 67, 95, 38, 74, 91, 39, 83, 82, 35, 92, 71, 37, 98, 64, 45, 100, 59, 48, 101,
  51, 58, 96, 46, 69, 95, 38, 80, 87, 34, 85, 80, 38, 90, 73, 49, 97, 102, 103, 98,
  100, 93, 95, 90, 85, 83, 54, 52, 53, 48, 59, 68, 155, 256, 132, 31, 47, 58, 106, 67,
  103, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102, 102,
  36, 80, 207, 329, 106, 28, 27, 22, 58, 102, 132, 126, 47, 66, 112, 168, 211, 215, 219, 341,
  338, 339, 338, 105, 6, 5, 6, 6, 6, 2, 0, 0, 0, 0,
];
const START_MIN = new Date('2026-11-01T06:50:00+01:00').getTime();

const replayMinutes = (endHoldMin = null) => {
  let m = ApplianceModel.initModel();
  let meter = 100;
  const finished = [];
  MINUTES.forEach((w, i) => {
    const t = START_MIN + i * MIN;
    meter += w / 60000;
    const r = ApplianceModel.processSample(m, {
      t, powerW: w, meterKwh: meter, timezone: TZ, endHoldMin,
    });
    m = r.model;
    if (r.event === 'finished') finished.push({ ...r.run, at: t });
  });
  return { model: m, finished };
};

test('per minute: two washes (restart), short longest pause inside each', () => {
  const { model, finished } = replayMinutes();
  assert.deepStrictEqual(finished.map((r) => `${hhmm(r.start)}-${hhmm(r.end)} at ${hhmm(r.at)}`), ['07:09-08:27 at 08:54']);
  assert.strictEqual(finished[0].pauseMin, 2);
  assert.strictEqual(hhmm(model.run.start), '08:41'); // still within 30 minutes of its end at 11:13
  assert.ok(model.run.maxPauseMs <= 3 * MIN, `pause ${model.run.maxPauseMs / MIN} min`);
});

test('per minute with a learned end time of 5 minutes: each wash ends 5 minutes after it', () => {
  const { finished } = replayMinutes(5);
  assert.deepStrictEqual(finished.map((r) => `${hhmm(r.start)}-${hhmm(r.end)} at ${hhmm(r.at)}`), ['07:09-08:27 at 08:32', '08:45-11:13 at 11:18']);
});

test('learned end time: 1.5 x the longest pause, 5 to 30 minutes', () => {
  const run = (startH, pauseMin) => ({
    start: START + startH * 3600000, end: START + startH * 3600000 + 90 * MIN, kwh: [0.5, 0.5], pauseMin,
  });
  const profile = (pauses) => ApplianceModel.getProfile({ ...ApplianceModel.initModel(), runs: pauses.map((x, i) => run(i * 24, x)) });
  assert.strictEqual(profile([2, 3, 2]).endHoldMin, 5);
  assert.strictEqual(profile([2, 3, 7]).endHoldMin, 11);
  assert.strictEqual(profile([6, 8, 30]).endHoldMin, 30);
  assert.strictEqual(profile([25, 30, 40]).endHoldMin, 30);
  assert.strictEqual(profile([2, 3, undefined]).endHoldMin, null);
});

test('a pause with heating again before the shortest program length: one run', () => {
  // Dishwasher: heats 20 min, 10 min passive, heats again for the hot rinse; shortest program 60 min.
  let m = ApplianceModel.initModel();
  let meter = 100;
  const events = [];
  const values = [...new Array(3).fill(2), ...new Array(20).fill(2000), ...new Array(10).fill(2), ...new Array(15).fill(2000), ...new Array(40).fill(2)];
  values.forEach((w, i) => {
    const t = START + i * MIN;
    meter += w / 60000;
    const r = ApplianceModel.processSample(m, {
      t, powerW: w, meterKwh: meter, timezone: TZ, shortestMin: 60,
    });
    m = r.model;
    if (r.event) events.push(r.event);
    if (r.restarted) events.push('restarted');
  });
  assert.deepStrictEqual(events, ['started', 'finished']);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
