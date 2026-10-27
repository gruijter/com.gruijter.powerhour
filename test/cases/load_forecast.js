'use strict';

const assert = require('assert');
const L = require('../../lib/strategies/LoadForecastStrategy');

const H = 3600 * 1000;
// Monday 2026-10-19 00:00 UTC; hourly entries, 500 W except 18:00 at 3000 W
const week = (from, days) => {
  const out = [];
  for (let i = 0; i < days * 24; i += 1) out.push({ t: from + i * H, v: i % 24 === 18 ? 3000 : 500 });
  return out;
};
const mon = Date.UTC(2026, 9, 19);
const current = L.initializeProfile().map((d) => d.map(() => 800));

// Nightly retrain on one week: every hour has 1 sample, live learning stays.
let r = L.processHistoricData({
  powerEntries: week(mon, 7), currentWeeklyProfile: current, timezone: 'UTC', minSamples: 2,
});
assert.ok(r.weeklyProfile.every((d) => d.every((v) => v === 800)), 'one sample per hour: learned kept');

// Two weeks: 2 samples per hour, history replaces.
r = L.processHistoricData({
  powerEntries: week(mon - 7 * 24 * H, 14), currentWeeklyProfile: current, timezone: 'UTC', minSamples: 2,
});
assert.strictEqual(r.weeklyProfile[1][0], 500, 'two samples: from history');

// An unlearned slot (0) is filled from one week of history.
const partly = current.map((d) => [...d]);
partly[1][8] = 0;
r = L.processHistoricData({
  powerEntries: week(mon, 7), currentWeeklyProfile: partly, timezone: 'UTC', minSamples: 2,
});
assert.ok(r.weeklyProfile[1][8] > 0 && r.weeklyProfile[1][8] !== 800, 'unlearned slot filled');
assert.strictEqual(r.weeklyProfile[1][9], 800);

// From scratch (minSamples 1): one week is used.
r = L.processHistoricData({ powerEntries: week(mon, 7), currentWeeklyProfile: L.initializeProfile(), timezone: 'UTC' });
assert.ok(r.weeklyProfile[1][72] > 1000, 'evening peak learned');
console.log('load forecast retrain tests passed');
