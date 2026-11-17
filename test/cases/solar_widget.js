/* eslint-disable no-console */

'use strict';

// Solar widget: getSolar() adds the chosen solar devices up per 15 minutes, as their chart images.
// Run: node test/cases/solar_widget.js

const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') {
    class Base {}
    return {
      Device: Base, Driver: Base, App: Base, SimpleClass: Base,
    };
  }
  return origLoad.call(this, request, ...rest);
};

const SolarDevice = require('../../drivers/solar/device');
const { getSolarSeries } = require('../../lib/charts/SolarChart');
const WidgetData = require('../../lib/helpers/WidgetData');
const SolarHistory = require('../../lib/helpers/SolarHistory');

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HOUR = 3600000;
const dayStart = new Date();
dayStart.setUTCHours(0, 0, 0, 0);
// Hourly radiation for yesterday, today and tomorrow: 0 at night, up to 800 W/m² at 12 UTC.
const forecastData = {};
for (let t = dayStart.getTime() - 24 * HOUR; t < dayStart.getTime() + 48 * HOUR; t += HOUR) {
  const h = new Date(t).getUTCHours();
  forecastData[t] = h >= 6 && h <= 18 ? Math.round(800 * Math.sin(((h - 6) / 12) * Math.PI)) : 0;
}

const solar = (id, yieldFactor, caps) => {
  const d = Object.create(SolarDevice.prototype);
  Object.assign(d, {
    id,
    timeZone: 'UTC',
    forecastData,
    yieldFactors: new Array(96).fill(yieldFactor),
    trainingConfidence: new Array(96).fill(0),
    powerHistory: [{ time: dayStart.getTime() + 12 * HOUR, power: 500 * yieldFactor }],
    forecastHistory: { yesterday: null, today: null },
    peakPowerAllTime: 1000 * yieldFactor,
    globalMaxYF: 0,
    intraday: null,
    caps,
    getId() {
      return this.id;
    },
    getName() {
      return this.id;
    },
    store: {},
    fileStore: { set() {}, flush: async () => {} },
    getSettings: () => ({}),
    getStoreValue(k) {
      return k === 'moneyUnit' ? { currency: 'EUR', decimals: 2 } : this.store[k];
    },
    async setStoreValue(k, v) {
      this.store[k] = v;
    },
    hasCapability(c) {
      return c in this.caps;
    },
    getCapabilityValue(c) {
      return this.caps[c];
    },
  });
  return d;
};

const rig = () => {
  const a = solar('a', 1, {
    meter_kwh_this_day: 2, meter_money_this_day: 0.5, measure_power: 300, 'measure_solar_use.this_day': 50,
  });
  const b = solar('b', 2, {
    meter_kwh_this_day: 3, meter_money_this_day: 0.25, measure_power: 100, 'measure_solar_use.this_day': 100,
  });
  const drivers = { solar: [a, b] };
  const homey = {
    clock: { getTimezone: () => 'UTC' },
    drivers: { getDriver: (id) => ({ getDevices: () => drivers[id] || [] }) },
  };
  return {
    a, b, homey, drivers,
  };
};

const now = new Date();
const Y = now.getUTCFullYear();
const M = now.getUTCMonth();
const D = now.getUTCDate();
const ago = (n) => new Date(Date.UTC(Y, M, D - n));
const reading = (dt) => ({ year: dt.getUTCFullYear(), month: dt.getUTCMonth(), day: dt.getUTCDate() });
const key = (dt) => dt.toISOString().slice(0, 10);

test('today: forecast and measured per slot summed; one total { kwh, own, money } from the meters', () => {
  const { a, b, homey } = rig();
  const s = WidgetData.getSolar(homey, 'today', []);
  assert.strictEqual(s.count, 2);
  const range = a.solarDayBounds('today');
  const sa = a.solarDay('today', range);
  const sb = b.solarDay('today', range);
  s.forecast.forEach((v, i) => assert.strictEqual(v, sa.forecast[i] + sb.forecast[i]));
  assert.strictEqual(s.real[s.real.findIndex((v) => typeof v === 'number')], 1500);
  assert.deepStrictEqual(s.total, {
    kwh: 5, own: 1 + 3, money: 0.75, est: false,
  });
  assert.strictEqual(s.nowW, 400);
});

test('own use per slot from the grid history: 1 - export / solar, nothing stored', () => {
  const { homey, drivers } = rig();
  drivers.grid = [{ powerHistory: [{ time: dayStart.getTime() + 12 * HOUR, power: 500, grid: -600 }] }];
  const s = WidgetData.getSolar(homey, 'today', []);
  const i = s.real.findIndex((v) => typeof v === 'number');
  assert.strictEqual(s.own[i], 0.6);
  assert.strictEqual(s.own[i + 8], null);
});

test('chosen ids: only those; unknown ids: all', () => {
  const { homey } = rig();
  assert.strictEqual(WidgetData.getSolar(homey, 'today', ['b']).total.kwh, 3);
  assert.strictEqual(WidgetData.getSolar(homey, 'today', ['x']).total.kwh, 5);
});

test('tomorrow: expected only', () => {
  const { homey } = rig();
  const s = WidgetData.getSolar(homey, 'tomorrow', []);
  assert.strictEqual(s.total, null);
  assert.ok(s.expectedKwh > 0);
});

test('weeks: 28 days with dates, today from the meters, logged days, totals from the bars', () => {
  const { a, b, homey } = rig();
  a.logDay(reading(ago(3)), 4, 0.5, 1);
  b.logDay(reading(ago(3)), 6, 0.25, 2);
  a.logDay(reading(ago(5)), 2, null, 0.4);
  const w = WidgetData.getSolar(homey, 'weeks', []);
  assert.strictEqual(w.bars.length, 28);
  assert.strictEqual(w.bars[27].date, key(ago(0)));
  assert.strictEqual(w.bars[27].kwh, 5);
  if (ago(3).getUTCFullYear() === Y) {
    assert.deepStrictEqual(w.bars[24], {
      kwh: 10, own: 3.5, money: 3, est: false, date: key(ago(3)),
    });
  }
  if (ago(5).getUTCFullYear() === Y) assert.strictEqual(w.bars[22].own, null); // a day without own use
  assert.strictEqual(w.total.kwh, 5 + 10 + 2);
  // One bar (2 of 17 kWh) without own use: scaled from the others, estimated.
  assert.strictEqual(w.total.own, ((4 + 3.5) * 17) / 15);
  assert.strictEqual(w.total.est, true);
  assert.strictEqual(Math.round(w.total.money * 100) / 100, 0.75 + 3 + 0.4);
});

test('year: months from their days; month share and value where days lack them', () => {
  const { a, homey, drivers } = rig();
  if (M === 0) return;
  drivers.solar = [a];
  a.logDay({ year: Y, month: M - 1, day: 1 }, 10, null, null);
  a.dayLogFor(Y).mShare[M - 1] = 0.4;
  a.dayLogFor(Y).mValue[M - 1] = 0.2;
  const y = WidgetData.getSolar(homey, 'year', []);
  assert.strictEqual(y.bars.length, 12);
  assert.deepStrictEqual(y.bars[M - 1], {
    kwh: 10, own: 4, money: 2, est: false,
  });
  assert.strictEqual(y.bars[M].kwh, 2); // this month so far: today
  if (M + 1 < 12) assert.strictEqual(y.bars[M + 1], null);
});

test('day log: a new year keeps the last 31 days of the old one', () => {
  const { a } = rig();
  a.logDay({ year: Y, month: 11, day: 30 }, 3, 0.4, 0.6);
  a.logDay({ year: Y, month: 0, day: 1 }, 2, 1, 0.1);
  a.logDay({ year: Y + 1, month: 0, day: 1 }, 1, 1, 0.2);
  const dec30 = Math.round((Date.UTC(Y, 11, 30) - Date.UTC(Y, 0, 1)) / 86400000);
  assert.deepStrictEqual(a.loggedDay(Y, dec30), {
    kwh: 3, own: 1.2, money: 0.6, est: false,
  });
  assert.strictEqual(a.loggedDay(Y, 0), null);
});

// A fake Insights: cumulative meters as 6-hour bucket means (thisYear), counters hourly (last14Days).
const fakeApi = (logs) => ({
  insights: {
    getLog: async ({ id }) => (logs[id] ? { id } : null),
    getLogEntries: async ({ id, resolution }) => {
      const l = logs[id];
      if (!l) return null;
      return resolution === 'thisYear' ? l.year || null : l.hours || null;
    },
  },
});
// 6-hour bucket means of a meter that rises by perBucket(startMs) in each bucket.
const meterLog = (fromMs, toMs, perBucket, start = 100) => {
  const values = [];
  let v = start;
  for (let t = fromMs; t < toMs; t += 6 * HOUR) {
    const inc = perBucket(t);
    values.push({ t: new Date(t).toISOString(), v: v + inc / 2 });
    v += inc;
  }
  return { year: { step: 6 * HOUR, values } };
};

test('history: kWh per day, own use estimated per 6 h (solar - export), a day with daytime battery discharge unknown, exact days kept', async () => {
  const { a, drivers } = rig();
  drivers.solar = [a];
  const grid = { sourceCapGroup: { n1: 'meter_power.exported' }, getSettings: () => ({ homey_device_id: 'p1' }) };
  const bat = { getId: () => 'bat', sourceCapGroup: {}, getSettings: () => ({}) };
  drivers.grid = [grid];
  drivers.battery = [bat];
  const jan1 = Date.UTC(Y, 0, 1);
  const end = Date.UTC(Y, M, D);
  const doy = (ms) => Math.round((ms - jan1) / 86400000);
  // Solar: 2 kWh in the 06-12 bucket, 1 in 12-18. Export: 0.5 in 12-18. Battery: discharging in the
  // 06-12 bucket only on day 2.
  const hour = (t) => new Date(t).getUTCHours();
  const logs = {
    'homey:device:a:meter_power_hidden': meterLog(jan1, end, (t) => ({ 6: 2, 12: 1 }[hour(t)] || 0)),
    'homey:device:p1:meter_power.exported': meterLog(jan1, end, (t) => (hour(t) === 12 ? 0.5 : 0)),
    'homey:device:bat:meter_kwh_discharging': meterLog(jan1, end, (t) => (doy(t) === 2 && hour(t) === 6 ? 1 : 0)),
  };
  a.ownMeterCaps = () => ['meter_power_hidden'];
  a.logDay({ year: Y, month: 0, day: 4 }, 9, 0.9, 9); // logged live: kept
  const homey = { drivers: { getDriver: (id) => ({ getDevices: () => drivers[id] || [] }) } };
  const driver = { homey, getDevices: () => drivers.solar };
  const result = await SolarHistory.fill(driver, fakeApi(logs));
  assert.ok(result.filled > 0);
  if (D + 31 * M < 6) return; // needs a few days of this year
  assert.deepStrictEqual(a.loggedDay(Y, 0), {
    kwh: 3, own: 2.5, money: null, est: true,
  });
  assert.strictEqual(a.loggedDay(Y, 2).own, null); // battery discharging beside the sun
  assert.deepStrictEqual(a.loggedDay(Y, 3), {
    kwh: 9, own: 8.1, money: 9, est: false,
  });
  assert.strictEqual(a.historyPending(), false);
});

test('history: a meter jump above peak x 12 h is no yield', async () => {
  const { a, drivers } = rig();
  drivers.solar = [a];
  const jan1 = Date.UTC(Y, 0, 1);
  const end = Date.UTC(Y, M, D);
  const doy = (ms) => Math.round((ms - jan1) / 86400000);
  const logs = { 'homey:device:a:meter_power_hidden': meterLog(jan1, end, (t) => (doy(t) === 1 && new Date(t).getUTCHours() === 6 ? 300 : 0)) };
  a.ownMeterCaps = () => ['meter_power_hidden'];
  const homey = { drivers: { getDriver: (id) => ({ getDevices: () => drivers[id] || [] }) } };
  await SolarHistory.fill({ homey, getDevices: () => drivers.solar }, fakeApi(logs));
  if (D + 31 * M < 3) return;
  assert.strictEqual(a.loggedDay(Y, 1), null);
  assert.strictEqual(a.loggedDay(Y, 0).kwh, 0);
});

test('series: forecast capped at the peak', () => {
  const s = getSolarSeries(forecastData, new Array(96).fill(5), new Date(dayStart.getTime() + 6 * HOUR), new Date(dayStart.getTime() + 18 * HOUR), [], 1000);
  assert.strictEqual(Math.max(...s.forecast), 1000);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${err.stack}`);
    }
  }
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
