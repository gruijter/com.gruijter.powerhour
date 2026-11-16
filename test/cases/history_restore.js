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

  await test('source meter p1 + p2 - n1 at a time', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const log = (base) => ({ step: 6 * HOUR, values: [0, 1, 2].map((i) => ({ t: new Date(t0 + i * 6 * HOUR).toISOString(), v: base + i })) });
    const logs = { 'homey:device:s:a': log(100), 'homey:device:s:b': log(10), 'homey:device:s:c': log(1) };
    const api = { insights: { getLog: async ({ id }) => (logs[id] ? { id } : null), getLogEntries: async ({ id }) => logs[id] } };
    const v = await HistoryRestore.sourceAt(api, 's', { p1: 'a', p2: 'b', n1: 'c' }, t0 + 9 * HOUR, new Map());
    assert.ok(Math.abs(v - (101 + 11 - 2)) < 1e-9, `got ${v}`); // 9 h = the centre of the second bucket
    assert.strictEqual(await HistoryRestore.sourceAt(api, 's', { p1: 'a', n1: 'x' }, t0 + 9 * HOUR, new Map()), null);
    assert.ok(ContractYear.meterAt);
  });

  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
