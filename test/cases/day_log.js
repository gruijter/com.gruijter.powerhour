/* eslint-disable no-console */

'use strict';

// Unit cases: day log years (leap year, a day of the year before) and the exact day end values
// from Insights hourly means.
// Run: node test/cases/day_log.js

const assert = require('assert');
const DayLog = require('../../lib/helpers/DayLog');
const SolarHistory = require('../../lib/helpers/SolarHistory');
const InsightsHistory = require('../../lib/helpers/InsightsHistory');

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

const H = 3600000;
const FIELDS = ['kwh', 'est'];

(async () => {
  await test('days of a year', () => {
    assert.strictEqual(DayLog.daysIn(2028), 366);
    assert.strictEqual(DayLog.daysIn(2029), 365);
  });

  await test('after a leap year: 31 Dec in prev', () => {
    const old = DayLog.yearLog(null, 1, 2028, FIELDS, []);
    old.kwh[365] = 7;
    const log = DayLog.yearLog(old, 1, 2029, FIELDS, []);
    assert.strictEqual(log.prev.from, 335);
    const slot = DayLog.daySlot(log, 1, 2028, 365);
    assert.strictEqual(slot.log.kwh[slot.i], 7);
  });

  await test('a day of the year before the log: no new log, written in prev', () => {
    const old = DayLog.yearLog(null, 1, 2026, FIELDS, []);
    const log = DayLog.yearLog(old, 1, 2027, FIELDS, []);
    log.kwh[0] = 3;
    assert.strictEqual(DayLog.yearLog(log, 1, 2026, FIELDS, []), null);
    const slot = DayLog.daySlot(log, 1, 2026, 364);
    assert.ok(slot && slot.log === log.prev);
    assert.strictEqual(DayLog.daySlot(log, 1, 2026, 10), null);
  });

  // Hourly means of a day counter (resets at midnight) and of its 'last day' counter.
  const next = Date.UTC(2026, 10, 18);
  const days = [{ doy: 321, ms: next - 24 * H, next }];
  const apiOf = (logs, step = H) => ({
    insights: {
      getLog: async ({ id }) => (logs[id.split(':').pop()] ? { id } : null),
      getLogEntries: async ({ id }) => ({
        step,
        values: Object.entries(logs[id.split(':').pop()]).map(([t, v]) => ({ t: new Date(Number(t)).toISOString(), v })),
      }),
    },
  });

  await test('flat last two hours: the last hour mean is exact', async () => {
    const api = apiOf({ day: { [next - 2 * H]: 5, [next - H]: 5 } });
    const out = await SolarHistory.dayEndValues(api, 'd', 'day', days);
    assert.strictEqual(out.get(321), 5);
  });

  await test('rising in the last hour: the last day counter, else unknown', async () => {
    const day = { [next - 2 * H]: 4, [next - H]: 6.75 };
    assert.strictEqual((await SolarHistory.dayEndValues(apiOf({ day }), 'd', 'day', days)).has(321), false);
    const api = apiOf({ day, last: { [next]: 6, [next + H]: 9.5 } });
    const out = await SolarHistory.dayEndValues(api, 'd', 'day', days, { lastCap: 'last', monotonic: true });
    assert.strictEqual(out.get(321), 9.5);
    const stale = apiOf({ day, last: { [next + H]: 2 } });
    assert.strictEqual((await SolarHistory.dayEndValues(stale, 'd', 'day', days, { lastCap: 'last', monotonic: true })).has(321), false);
  });

  await test('6-hour last14Days: not used', async () => {
    const api = apiOf({ day: { [next - 6 * H]: 5 } }, 6 * H);
    assert.strictEqual((await SolarHistory.dayEndValues(api, 'd', 'day', days)).size, 0);
  });

  await test('tracked api counts failed reads', async () => {
    const api = InsightsHistory.tracked({
      insights: {
        getLog: async () => null,
        getLogEntries: async () => {
          throw new Error('rate');
        },
      },
    });
    await api.insights.getLogEntries({}).catch(() => null);
    assert.strictEqual(api.failed, 1);
  });

  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
