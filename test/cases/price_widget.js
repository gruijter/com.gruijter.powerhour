/* eslint-disable no-console */

'use strict';

// Price widget: getPrice() picks the price device and lays out the prices of one day per interval.
// Run: node test/cases/price_widget.js

const assert = require('assert');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const WidgetData = require('../../lib/helpers/WidgetData');

const TZ = 'Europe/Amsterdam';

const priceDevice = (id, {
  group = 1, gas = false, interval = 15, exportLine = true,
} = {}) => {
  const periods = TimeHelpers.getUTCPeriods(TZ, interval);
  const start = periods.todayStart.getTime();
  const n = (periods.tomorrowEnd.getTime() - start) / (interval * 60000);
  const known = (periods.tomorrowStart.getTime() - start) / (interval * 60000) + 4; // tomorrow: 4 slots known
  return {
    id,
    isDeleted: false,
    driver: { id: 'price' },
    hasExport: !gas,
    priceInterval: interval,
    timeZone: TZ,
    prices: Array.from({ length: n }, (_, i) => ({
      time: new Date(start + i * interval * 60000).toISOString(),
      price: i / 1000,
      muPrice: i / 100,
      exportPrice: i / 200,
      isForecast: i >= known,
    })),
    getId: () => id,
    getName: () => `Price ${id}`,
    getSettings: () => ({
      tariff_update_group: group, commodity: gas ? 'gas' : 'power', currency: '€', decimals: 3, export_show_chart_line: exportLine,
    }),
    getUTCPeriods() {
      return TimeHelpers.getUTCPeriods(TZ, interval);
    },
  };
};

const homeyWith = (devices, grids = [{ getSettings: () => ({ tariff_update_group: 2 }) }]) => ({
  clock: { getTimezone: () => TZ },
  drivers: {
    getDriver: (id) => {
      if (id === 'price') return { getDevices: () => devices };
      if (id === 'grid') return { getDevices: () => grids };
      throw Error('no driver');
    },
  },
});

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.stack}`);
  }
};

test('no device: null; device without interval: false', () => {
  assert.strictEqual(WidgetData.getPrice(homeyWith([]), 'today').price, null);
  const d = priceDevice('a');
  d.priceInterval = undefined;
  assert.strictEqual(WidgetData.getPrice(homeyWith([d]), 'today').price, false);
});

test('default: electricity device of the grid group; chosen id wins', () => {
  const gas = priceDevice('gas', { gas: true, group: 2 });
  const g1 = priceDevice('g1', { group: 1 });
  const g2 = priceDevice('g2', { group: 2 });
  const homey = homeyWith([gas, g1, g2]);
  assert.strictEqual(WidgetData.getPrice(homey, 'today').name, 'Price g2');
  assert.strictEqual(WidgetData.getPrice(homey, 'today', ['gas']).name, 'Price gas');
  assert.strictEqual(WidgetData.getPrice(homeyWith([g1], []), 'today').name, 'Price g1');
});

test('today: a full day per interval, import = muPrice, export line per setting', () => {
  const d = WidgetData.getPrice(homeyWith([priceDevice('a', { group: 2 })]), 'today');
  const periods = TimeHelpers.getUTCPeriods(TZ, 15);
  const n = (periods.tomorrowStart - periods.todayStart) / 900000;
  assert.strictEqual(d.import.length, n);
  assert.strictEqual(d.startMs, periods.todayStart.getTime());
  assert.strictEqual(d.slotMs, 900000);
  assert.strictEqual(d.import[5], 0.05);
  assert.strictEqual(d.export[5], 0.025);
  assert.strictEqual(d.decimals, 3);
  assert.ok(d.forecast.every((f) => !f));
  const noLine = WidgetData.getPrice(homeyWith([priceDevice('a', { group: 2, exportLine: false })]), 'today');
  assert.strictEqual(noLine.export, null);
});

test('tomorrow: expected prices flagged; hourly device', () => {
  const d = WidgetData.getPrice(homeyWith([priceDevice('a', { group: 2 })]), 'tomorrow');
  assert.deepStrictEqual(d.forecast.slice(0, 5), [false, false, false, false, true]);
  const h = WidgetData.getPrice(homeyWith([priceDevice('h', { group: 2, interval: 60 })]), 'tomorrow');
  assert.ok(h.import.length >= 23 && h.import.length <= 25);
  assert.strictEqual(h.slotMs, 3600000);
  const gas = WidgetData.getPrice(homeyWith([priceDevice('g', { gas: true, interval: 60 })]), 'today');
  assert.strictEqual(gas.export, null);
});

if (failed) process.exitCode = 1;
