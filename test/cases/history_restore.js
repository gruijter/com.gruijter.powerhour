/* eslint-disable no-console */

'use strict';

// A newly paired meter: its periods from Insights (HistoryRestore). Run: node test/cases/history_restore.js

const assert = require('assert');
const HistoryRestore = require('../../lib/helpers/HistoryRestore');
const ContractYear = require('../../lib/helpers/ContractYear');

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

const HOUR = 3600 * 1000;
const TZ = 'Europe/Amsterdam';

(async () => {
  await test('period starts on the contract start, this and last', async () => {
    const s = HistoryRestore.periodStarts(new Date(2026, 10, 16, 17), 15, 2, TZ);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.deepStrictEqual(s.day.map(iso), ['2026-11-14', '2026-11-15']); // local midnights in UTC
    assert.deepStrictEqual(s.month.map(iso), ['2026-10-14', '2026-11-14']);
    assert.deepStrictEqual(s.year.map(iso), ['2025-03-14', '2026-03-14']);
  });

  await test('energy since a time from power buckets, part of a bucket counts pro rata', async () => {
    const t0 = Date.UTC(2026, 10, 1);
    const buckets = [0, 1, 2, 3].map((i) => ({ t: t0 + i * 6 * HOUR, end: t0 + (i + 1) * 6 * HOUR, w: 1000 }));
    assert.strictEqual(HistoryRestore.energySince(buckets, t0 + 3 * HOUR), 21);
    assert.strictEqual(HistoryRestore.energySince(buckets, t0 - HOUR), null);
  });

  await test('growth since a time: drops are resets, skipped', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const vals = [100, 110, 120, 20, 30, 40]; // reset after 120
    const logs = { 'homey:device:s:a': { step: 6 * HOUR, values: vals.map((v, i) => ({ t: new Date(t0 + i * 6 * HOUR).toISOString(), v })) } };
    const api = { insights: { getLog: async ({ id }) => (logs[id] ? { id } : null), getLogEntries: async ({ id }) => logs[id] } };
    // From the centre of the first bucket: 10 + 10 + (reset) + 10 + 10, then 45 now: +5.
    assert.strictEqual(await ContractYear.growthSince(api, 's', ['a'], t0 + 3 * HOUR, { nowValue: 45 }), 45);
    assert.strictEqual(await ContractYear.growthSince(api, 's', ['a'], t0 - HOUR), null);
    assert.strictEqual(await ContractYear.growthSince(api, 's', ['a'], t0 - HOUR, { orFirst: true }), 40);
    const g = await HistoryRestore.sourceGrowth(api, 's', { p1: 'a', n1: 'a' }, { p1: 45, n1: 45 }, t0 + 3 * HOUR, new Map());
    assert.strictEqual(g, 0);
  });

  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
