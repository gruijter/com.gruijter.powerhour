/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/BatteryDayLog.js: the day that ended is logged from the 'last day'
// meters; a loss (money below 0, also exactly -1) stays apart from unknown.
// Run: node test/cases/battery_day_log.js

const assert = require('assert');
const FileStore = require('../../lib/helpers/FileStore');
const BatteryDayLog = require('../../lib/helpers/BatteryDayLog');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');

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

const files = new Map();
FileStore.open = async () => ({ get: (k) => files.get(k), set: (k, v) => files.set(k, v) });

const battery = (caps, lastDay) => ({
  timeZone: 'Europe/Amsterdam',
  homey: { clock: { getTimezone: () => 'Europe/Amsterdam' } },
  hasCapability: (id) => id in caps,
  getCapabilityValue: (id) => caps[id],
  meterMoney: { lastDay },
});
const yesterday = () => {
  const midnight = TimeHelpers.getLocalMidnightUTC(new Date(), 'Europe/Amsterdam').getTime();
  const d = TimeHelpers.toLocalDate(new Date(midnight - 1), 'Europe/Amsterdam');
  return [d.getFullYear(), BatteryDayLog.doyOf(d.getFullYear(), d.getMonth(), d.getDate())];
};

(async () => {
  await test('the day that ended, from the last day meters', async () => {
    const dev = battery({ 'meter_kwh_last_day.charged': 5.25, 'meter_kwh_last_day.discharged': 4.5 }, 1.23);
    await BatteryDayLog.logYesterday(dev);
    const [y, doy] = yesterday();
    assert.deepStrictEqual(BatteryDayLog.loggedDay(dev, y, doy), {
      charged: 5.25, discharged: 4.5, money: 1.23, est: false,
    });
    assert.strictEqual(BatteryDayLog.loggedDay(dev, y, doy - 1), null);
  });

  await test('a loss of exactly 1 is not unknown', async () => {
    const dev = battery({ 'meter_kwh_last_day.charged': 1, 'meter_kwh_last_day.discharged': 0 }, -1);
    await BatteryDayLog.logYesterday(dev);
    const [y, doy] = yesterday();
    assert.ok(Math.abs(BatteryDayLog.loggedDay(dev, y, doy).money + 1) < 0.001);
  });

  await test('without meters nothing is logged', async () => {
    const dev = battery({}, 2);
    await BatteryDayLog.logYesterday(dev);
    const [y, doy] = yesterday();
    assert.strictEqual(BatteryDayLog.loggedDay(dev, y, doy), null);
  });

  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
