/* eslint-disable no-console */

'use strict';

// Unit cases for InsightsHistory.fetchSeries() (battery and EV charger history).
// Run: node test/cases/insights_history.js

const assert = require('assert');
const { fetchSeries, meterToPower, HOUR_MS } = require('../../lib/helpers/InsightsHistory');
const { convertCumulativeToPower } = require('../../lib/helpers/HistoryLookup');

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
  await test('hourly for the older part, 5 minutes for the last day; no time shift', async () => {
    const data = {
      last7Days: points(END - 30 * HOUR_MS, HOUR_MS, [10, 20, 30, 40, 50, 60, 70, 80]),
      last24Hours: points(END - 24 * HOUR_MS, 5 * 60 * 1000, [1, 2, 3]),
    };
    const out = await fetchSeries({ api: apiOf(data), log: { id: 'homey:device:a:measure_power.battery' }, ...range });
    // Every log is stamped at the start of its bucket (measured 2026-11-14).
    assert.deepStrictEqual(out.slice(0, 2), [{ t: END - 30 * HOUR_MS, v: 10 }, { t: END - 29 * HOUR_MS, v: 20 }]);
    assert.strictEqual(out.filter((e) => e.t < END - 24 * HOUR_MS).length, 6); // the seventh hour is in the fine data
    assert.deepStrictEqual(out.slice(-3).map((e) => e.v), [1, 2, 3]);
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
    assert.deepStrictEqual(up.map((e) => Math.round(e.v)), [1000, 1000, 1500, 1500]); // the drop: a reset
    assert.strictEqual(up[0].t, END - 30 * HOUR_MS);
    const signed = await fetchSeries({
      api: apiOf(data), log, ...range, signed: true,
    });
    assert.deepStrictEqual(signed.map((e) => Math.round(e.v)), [1000, 250, 500, 1500]);
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
    assert.deepStrictEqual(meter, [{ t: END - 2 * HOUR_MS, v: 1000 }, { t: END, v: 1000 }]);
  });

  await test('a meter is a bucket mean: its power lands in the right hour', async () => {
    // 2 kW from 10:00 to 11:00. Insights gives the mean meter reading of each hour.
    const T = (h) => Date.UTC(2026, 10, 10, h);
    const reading = (ms) => Math.min(2, Math.max(0, (ms - T(10)) / HOUR_MS) * 2);
    const meanOfHour = (h) => {
      let sum = 0;
      for (let m = 0; m < 60; m += 1) sum += reading(T(h) + (m + 0.5) * 60000);
      return sum / 60;
    };
    const hours = [7, 8, 9, 10, 11, 12, 13];
    const power = meterToPower(hours.map((h) => ({ t: new Date(T(h)).toISOString(), v: meanOfHour(h) })));
    const kwh = power.reduce((a, p) => a + p.v / 1000, 0);
    assert.ok(Math.abs(kwh - 2) < 1e-6, `energy kept (${kwh})`);
    // The weight of the power: the middle of the 10:00 hour (entries stand for [t, t + 1 h)).
    const centre = power.reduce((a, p) => a + (p.t + HOUR_MS / 2) * p.v, 0) / power.reduce((a, p) => a + p.v, 0);
    assert.strictEqual(centre, T(10) + HOUR_MS / 2);
    // Charts: repeated every 5 minutes from the entry on.
    const stepped = convertCumulativeToPower(hours.map((h) => ({ t: new Date(T(h)).toISOString(), v: meanOfHour(h) })));
    assert.strictEqual(stepped[0].t, T(7));
    assert.strictEqual(stepped.filter((e) => e.t >= T(10) && e.t < T(11)).length, 12);
    assert.ok(stepped.every((e) => e.t % (5 * 60000) === 0));
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
