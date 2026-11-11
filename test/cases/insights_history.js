/* eslint-disable no-console */

'use strict';

// Unit cases for InsightsHistory.fetchSeries() (battery and EV charger history).
// Run: node test/cases/insights_history.js

const assert = require('assert');
const { fetchSeries, HOUR_MS } = require('../../lib/helpers/InsightsHistory');

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

const END = Date.UTC(2026, 10, 10, 12, 0, 0);
const range = { startDate: new Date(END - 48 * HOUR_MS), endDate: new Date(END) };
// data: { resolution: { step, values } }
const apiOf = (data, asked = []) => ({
  insights: {
    getLogEntries: async ({ resolution }) => {
      asked.push(resolution);
      return data[resolution] || { values: [] };
    },
  },
});
const points = (fromMs, stepMs, values) => ({ step: stepMs, values: values.map((v, i) => ({ t: new Date(fromMs + i * stepMs).toISOString(), v })) });

(async () => {
  await test('hourly for the older part, 5 minutes for the last day; end-stamped hours shifted', async () => {
    const data = {
      last7Days: points(END - 30 * HOUR_MS, HOUR_MS, [10, 20, 30, 40, 50, 60, 70, 80]),
      last24Hours: points(END - 24 * HOUR_MS, 5 * 60 * 1000, [1, 2, 3]),
    };
    const out = await fetchSeries({ api: apiOf(data), log: { id: 'homey:device:a:measure_power.battery' }, ...range });
    // The hours before the fine data, each an hour earlier (stamped at the end of its hour).
    assert.deepStrictEqual(out.slice(0, 2), [{ t: END - 31 * HOUR_MS, v: 10 }, { t: END - 30 * HOUR_MS, v: 20 }]);
    assert.strictEqual(out.filter((e) => e.t < END - 24 * HOUR_MS).length, 7); // the eighth hour is in the fine data
    assert.deepStrictEqual(out.slice(-3).map((e) => e.v), [1, 2, 3]);
    // Stamped at the start of the hour: no shift.
    const soc = await fetchSeries({ api: apiOf(data), log: { id: 'homey:device:a:measure_battery' }, ...range });
    assert.strictEqual(soc[0].t, END - 30 * HOUR_MS);
  });

  await test('coarse data is skipped by its step, whatever the resolution is called', async () => {
    const asked = [];
    const data = {
      last7Days: points(END - 30 * HOUR_MS, 6 * HOUR_MS, [10, 20]),
      last14Days: points(END - 30 * HOUR_MS, HOUR_MS, [5, 6]),
    };
    const out = await fetchSeries({
      api: apiOf(data, asked), log: { id: 'x:energy_power' }, ...range, coarseResolutions: ['last7Days', 'last14Days'],
    });
    assert.deepStrictEqual(out.map((e) => e.v), [5, 6]);
    assert.deepStrictEqual(asked, ['last7Days', 'last14Days', 'last24Hours']);
  });

  await test('a cumulative meter becomes power; going down only when signed', async () => {
    const data = { last7Days: points(END - 30 * HOUR_MS, HOUR_MS, [100, 101, 100.5, 102]) };
    const log = { id: 'x:meter_power' };
    const up = await fetchSeries({ api: apiOf(data), log, ...range });
    assert.deepStrictEqual(up.map((e) => Math.round(e.v)), [1000, 1500]);
    assert.strictEqual(up[0].t, END - 30 * HOUR_MS); // the start of its interval
    const signed = await fetchSeries({
      api: apiOf(data), log, ...range, signed: true,
    });
    assert.deepStrictEqual(signed.map((e) => Math.round(e.v)), [1000, -500, 1500]);
  });

  await test('nothing in the coarse and fine data: today, else null', async () => {
    const today = { today: points(END - 2 * HOUR_MS, 5 * 60 * 1000, [7]) };
    assert.deepStrictEqual((await fetchSeries({ api: apiOf(today), log: { id: 'x:energy_power' }, ...range })).map((e) => e.v), [7]);
    assert.strictEqual(await fetchSeries({ api: apiOf({}), log: { id: 'x:energy_power' }, ...range }), null);
  });

  await test('gaps (null) are skipped, not read as 0', async () => {
    const fine = (vals) => ({ last24Hours: points(END - 2 * HOUR_MS, HOUR_MS, vals) });
    const soc = await fetchSeries({ api: apiOf(fine([50, null, 60])), log: { id: 'x:measure_battery' }, ...range });
    assert.deepStrictEqual(soc.map((e) => e.v), [50, 60]);
    // A signed meter across a gap: the average between the points around it.
    const meter = await fetchSeries({
      api: apiOf(fine([100, null, 102])), log: { id: 'x:meter_power' }, ...range, signed: true,
    });
    assert.deepStrictEqual(meter, [{ t: END - 2 * HOUR_MS, v: 1000 }]);
  });

  await test('one meter reading: no power', async () => {
    const out = await fetchSeries({
      api: apiOf({ last24Hours: points(END - HOUR_MS, HOUR_MS, [2345]) }), log: { id: 'x:meter_power' }, ...range,
    });
    assert.strictEqual(out, null);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
