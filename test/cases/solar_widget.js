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
    getSettings: () => ({}),
    getStoreValue: (k) => (k === 'moneyUnit' ? { currency: 'EUR', decimals: 2 } : null),
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
  const a = solar('a', 1, { meter_kwh_this_day: 2, meter_money_this_day: 0.5, measure_power: 300 });
  const b = solar('b', 2, { meter_kwh_this_day: 3, meter_money_this_day: 0.25, measure_power: 100 });
  const drivers = { solar: [a, b] };
  const homey = {
    clock: { getTimezone: () => 'UTC' },
    drivers: { getDriver: (id) => ({ getDevices: () => drivers[id] || [] }) },
  };
  return { a, b, homey };
};

test('today: forecast and measured added up per slot, meters summed', () => {
  const { a, b, homey } = rig();
  const s = WidgetData.getSolar(homey, 'today', []);
  assert.strictEqual(s.count, 2);
  const range = a.solarDayBounds('today');
  const sa = a.solarDay('today', range);
  const sb = b.solarDay('today', range);
  assert.strictEqual(s.forecast.length, sa.forecast.length);
  s.forecast.forEach((v, i) => assert.strictEqual(v, sa.forecast[i] + sb.forecast[i]));
  const noon = s.real.findIndex((v) => typeof v === 'number');
  assert.strictEqual(s.real[noon], 1500);
  assert.strictEqual(s.kwh, 5);
  assert.strictEqual(s.money, 0.75);
  assert.strictEqual(s.nowW, 400);
  assert.strictEqual(s.peak, 3000);
  assert.strictEqual(s.currency, 'EUR');
});

test('chosen ids: only those; unknown ids: all', () => {
  const { homey } = rig();
  assert.strictEqual(WidgetData.getSolar(homey, 'today', ['b']).kwh, 3);
  assert.strictEqual(WidgetData.getSolar(homey, 'today', ['x']).kwh, 5);
});

test('tomorrow: no measured meters', () => {
  const { homey } = rig();
  const s = WidgetData.getSolar(homey, 'tomorrow', []);
  assert.strictEqual(s.kwh, null);
  assert.ok(s.expectedKwh > 0);
});

test('day log: compact arrays, logged days per day and month bars with own use', () => {
  const { a, b, homey } = rig();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  a.fileStore = { set() {} };
  b.fileStore = { set() {} };
  a.logDay({ year: y, month: m, day: 1 }, 4, 0.5);
  b.logDay({ year: y, month: m, day: 1 }, 6, 0.25);
  a.logDay({ year: y, month: 0, day: 1 }, 2, null);
  assert.strictEqual(a.dayLog.kwh.length, 366);
  assert.deepStrictEqual(a.loggedDay(y, 0), [2, null]);
  Object.assign(a.caps, { meter_kwh_this_month: 30, 'measure_solar_use.this_month': 50 });
  Object.assign(b.caps, { meter_kwh_this_month: 10, 'measure_solar_use.this_month': 100 });
  const month = WidgetData.getSolar(homey, 'month', []);
  assert.strictEqual(month.kwh, 40);
  assert.strictEqual(month.share, 25 / 40);
  if (now.getUTCDate() > 1) assert.deepStrictEqual(month.bars[0], { kwh: 10, own: 3.5 });
  assert.strictEqual(month.bars.length, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  const year = WidgetData.getSolar(homey, 'year', []);
  assert.strictEqual(year.bars.length, 12);
  assert.strictEqual(year.bars[m].kwh, 40);
  if (m > 0) assert.strictEqual(year.bars[0].own, null); // a day without share: no split
  a.logDay({ year: y + 1, month: 0, day: 1 }, 1, 1);
  assert.strictEqual(a.loggedDay(y, 0), null); // a new year starts a new log
});

test('yesterday without a frozen forecast: no chart', () => {
  const { homey } = rig();
  assert.strictEqual(WidgetData.getSolar(homey, 'yesterday', []).forecast, null);
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
