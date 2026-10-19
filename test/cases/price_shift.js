'use strict';

// node test/cases/price_shift.js — PriceShift (broadcast only with news, price now from a list) and
// LoadSpread (charts after a slot boundary's burst).

const assert = require('assert');
const PriceShift = require('../../lib/helpers/PriceShift');
const LoadSpread = require('../../lib/helpers/LoadSpread');

let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log('ok  ', name);
  } catch (err) {
    failures += 1;
    console.log('FAIL', name, '\n    ', err.message);
  }
};

const TZ = 'Europe/Amsterdam';
const Q = 15 * 60 * 1000;
const start = Date.UTC(2026, 9, 19, 6, 0); // 08:00 Amsterdam
const list = [0.30, 0.31, 0.32, 0.33, 0.34];
const exportList = [0.28, 0.29, 0.30, 0.31, 0.32];
const tick = () => new Promise((r) => {
  setImmediate(r);
});
const payload = (k, prices, extra = {}) => ({
  pricesNextHours: prices,
  exportPricesNextHours: exportList.slice(list.length - prices.length),
  pricesNextHoursIsForecast: prices.map(() => false),
  pricesNextHoursMarketLength: prices.length,
  pricesStartTm: start + (k * Q),
  priceInterval: 15,
  group: 7,
  currency: '€',
  exchangeRate: 1,
  ...extra,
});

(async () => {
  await test('shift only: one and two slots later', () => {
    assert.ok(PriceShift.isShiftOnly(payload(0, list), payload(1, list.slice(1))));
    assert.ok(PriceShift.isShiftOnly(payload(0, list), payload(2, list.slice(2))));
    assert.ok(PriceShift.isShiftOnly(payload(0, list), payload(0, list)), 'same broadcast again');
  });

  await test('news: other price, longer list, other settings', () => {
    assert.ok(!PriceShift.isShiftOnly(payload(0, list), payload(1, [0.31, 0.32, 0.99, 0.34])), 'changed price');
    assert.ok(!PriceShift.isShiftOnly(payload(0, list), payload(1, [...list.slice(1), 0.35])), 'tomorrow arrived');
    assert.ok(!PriceShift.isShiftOnly(payload(0, list), payload(1, list.slice(1), { group: 2 })), 'group');
    assert.ok(!PriceShift.isShiftOnly(payload(0, list), payload(1, list.slice(1), { currency: 'kr' })), 'currency');
    const fc = payload(1, list.slice(1));
    fc.pricesNextHoursIsForecast = [true, false, false, false];
    assert.ok(!PriceShift.isShiftOnly(payload(0, list), fc), 'forecast flag');
    assert.ok(!PriceShift.isShiftOnly(null, payload(0, list)), 'first broadcast');
    assert.ok(!PriceShift.isShiftOnly(payload(1, list), payload(0, list)), 'earlier start');
    assert.ok(!PriceShift.isShiftOnly(payload(0, list, { pricesStartTm: undefined }), payload(0, list)), 'no start (flow)');
  });

  await test('price now from the list, past its end the last', () => {
    const l = {
      prices: list, exportPrices: exportList, startTm: start, interval: 15,
    };
    assert.deepStrictEqual(PriceShift.priceNow(l, TZ, start + 5000), { tariff: 0.30, exportTariff: 0.28 });
    assert.strictEqual(PriceShift.priceNow(l, TZ, start + (2 * Q) + 1).tariff, 0.32);
    assert.strictEqual(PriceShift.priceNow(l, TZ, start + (40 * Q)).tariff, 0.34);
    assert.strictEqual(PriceShift.priceNow({ prices: [0.25], interval: 15 }, TZ, start), null, 'no start: as received');
    assert.strictEqual(PriceShift.priceNow({ ...l, exportPrices: null }, TZ, start).exportTariff, 0.30, 'export = import');
  });

  await test('LoadSpread: now outside the burst, later and merged in it', async () => {
    const realNow = Date.now;
    const timers = [];
    const device = {
      timeZone: TZ,
      homey: { setTimeout: (fn, ms) => timers.push({ fn, ms }) },
      error: (e) => {
        throw e;
      },
    };
    try {
      let runs = [];
      Date.now = () => start + (5 * 60 * 1000); // 08:05: no burst
      await LoadSpread.run(device, 'c', async () => runs.push('now'));
      assert.deepStrictEqual(runs, ['now']);

      runs = [];
      Date.now = () => start + 3000; // 08:00:03
      await LoadSpread.run(device, 'c', async () => runs.push('first'));
      await LoadSpread.run(device, 'c', async () => runs.push('latest'));
      assert.deepStrictEqual(runs, [], 'deferred');
      assert.strictEqual(timers.length, 1, 'one timer per key');
      assert.ok(timers[0].ms >= 87000 && timers[0].ms <= 207000, `delay ${timers[0].ms}`);
      timers[0].fn();
      await tick();
      assert.deepStrictEqual(runs, ['latest']);

      runs = [];
      device.isDestroyed = true;
      await LoadSpread.run(device, 'c', async () => runs.push('gone'));
      timers[1].fn();
      await tick();
      assert.deepStrictEqual(runs, [], 'not on a deleted device');
    } finally {
      Date.now = realNow;
    }
  });

  if (failures) console.log(`${failures} FAILED`);
  process.exitCode = failures ? 1 : 0;
})().catch((err) => {
  console.log('FAIL', err.message);
  process.exitCode = 1;
});
