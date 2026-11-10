/* eslint-disable no-console */

'use strict';

// Unit cases for the plan of a charge device apart from its charts: ChargeDeviceHelpers.applyPlan()
// and lib/helpers/BatteryPlan.js. Run: node test/cases/charge_plan.js

const assert = require('assert');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const BatteryPlan = require('../../lib/helpers/BatteryPlan');
const MeterDeviceMixin = require('../../lib/genericDeviceDrivers/MeterDeviceMixin');

const NOW = Date.UTC(2026, 10, 10, 12, 5, 0); // 5 min into a quarter
Date.now = () => NOW;
const MIN = 60 * 1000;

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

const device = (over = {}) => {
  const logs = [];
  return Object.assign(Object.create(ChargeDeviceHelpers), {
    logs,
    timeZone: 'UTC',
    ds: { planIntervalMin: 15 },
    priceInterval: 60,
    soc: 40,
    sessionId: 's1',
    pricesNextHours: [0.3, 0.1, 0.1, 0.4, 0.4],
    homey: { clock: { getTimezone: () => 'UTC' }, drivers: { getDriver: () => ({ getDevices: () => [] }) }, __: (k) => k },
    getStoreValue: () => null,
    setStoreValue: async () => {},
    getName: () => 'Bat',
    getSettings: () => ({ precisePlanning: false }),
    log: (...args) => logs.push(args.join(' ')),
    error: (err) => {
      throw err;
    },
  }, over);
};

(async () => {
  await test('applyPlan(): the plan is in use without a chart drawn', async () => {
    const d = device();
    const scheme = {
      0: {
        power: 1000, duration: 10, soc: 42, block: 'charge',
      },
      1: {
        power: 0, duration: 0, soc: 42, block: 'hold', quiet: true,
      },
      2: {
        power: -500, duration: 15, soc: 40, block: 'xom',
      },
    };
    // The periods are of the real clock (new Date()): the slot from what applyPlan() returns.
    const periods = await d.applyPlan({ scheme, planTm: 0, planSlots: 2 });
    const slotMs = 15 * MIN;
    const startMs = Math.floor(periods.now.getTime() / slotMs) * slotMs;
    assert.strictEqual(d.latestPlan.startMs, startMs);
    assert.strictEqual(d.latestPlan.firstSlotMinutes, 15); // planned before the slot: all of it
    assert.strictEqual(d.latestPlan.startSoc, 40);
    assert.strictEqual(d.latestPlan.slots.length, 2); // the third slot is only shown
    assert.deepStrictEqual(d.latestPlan.slots[1], {
      power: 0, duration: 0, solarExtra: false, block: 'hold', noCharge: false, minSolarW: 0, quiet: true, soc: 42,
    });
    // 1000 W for 10 of the 15 minutes; outside the executed slots: no plan.
    assert.deepStrictEqual(d.getPlannedPowerSeries(startMs, startMs + 45 * MIN), [667, 0, null]);
    const slotInDay = Math.floor((startMs - periods.todayStart.getTime()) / slotMs);
    assert.strictEqual(d.plannedScheduleStore.todaySchedule[slotInDay].power, 1000);
    assert.strictEqual(d.chartTodayCharge, undefined);
  });

  await test('BatteryPlan.tokens(): tokens of the plan, from the cache when nothing changed', async () => {
    const options = {
      prices: [0.3, 0.3, 0.3, 0.05, 0.05, 0.05, 0.05, 0.4, 0.4, 0.4, 0.4, 0.4],
      minPriceDelta: 0.02,
      soc: 0,
      batCapacity: 2,
      startMinute: 5,
      priceInterval: 15,
      homePowerUsage: 300,
      net: null,
    };
    const d = device({ buildPlanOptions: () => options, planSocToReal: (soc) => soc });
    const tokens = await BatteryPlan.tokens(d, { minPriceDelta: 0.02 }, false);
    const scheme = JSON.parse(tokens.scheme);
    assert.strictEqual(Object.keys(scheme).length, 12);
    assert.ok(Object.values(scheme).some((slot) => slot.block === 'charge'), 'charges in the cheap slots');
    assert.strictEqual(tokens.power, scheme[0].power);
    assert.strictEqual(d.lastPlanTm, NOW);
    assert.ok(d.logs.some((l) => l.includes('[Plan] light')));
    // The same input: no new plan; the inverted card gets the opposite power.
    const before = d.logs.length;
    const again = await BatteryPlan.tokens(d, { minPriceDelta: 0.02, invert_power: true }, false);
    assert.ok(d.logs.slice(before).some((l) => l.includes('From cache')));
    assert.strictEqual(again.scheme, tokens.scheme);
    assert.strictEqual(again.power, tokens.power ? -tokens.power : tokens.power);
    // Without prices: an error for the flow card.
    await assert.rejects(BatteryPlan.tokens(device({ pricesNextHours: null }), { minPriceDelta: 0.02 }, false), /error_no_prices/);
  });

  await test('MeterDeviceMixin: start date, money rollover, restart', async () => {
    const caps = {};
    const order = [];
    const m = Object.assign(Object.create(MeterDeviceMixin), {
      hasCapability: () => true,
      getCapabilityValue: (cap) => (cap in caps ? caps[cap] : null),
      setCapabilityValue: async (cap, value) => {
        caps[cap] = value;
      },
      homey: { setTimeout: (fn) => fn() },
      log: () => {},
      error: () => {},
      stopPolling: () => order.push('stopPolling'),
      flushStore: async () => order.push('flushStore'),
      onInit: async () => order.push('onInit'),
      capabilityInstances: { a: { destroy: () => order.push('destroy') } },
    });
    m.readStartDate('1503');
    assert.deepStrictEqual([m.startDay, m.startMonth], [15, 2]);
    m.readStartDate('9999');
    assert.deepStrictEqual([m.startDay, m.startMonth], [1, 0]);
    m.readStartDate(undefined);
    assert.deepStrictEqual([m.startDay, m.startMonth], [1, 0]);

    const money = {
      hour: 1, day: 2, month: 3, year: 4, lastHour: 0, lastDay: 0, lastMonth: 0, lastYear: 0,
    };
    assert.deepStrictEqual(await m.rollMoneyPeriods(money, { newHour: true, newDay: true }), ['hour', 'day']);
    assert.deepStrictEqual(money, {
      hour: 0, day: 0, month: 3, year: 4, lastHour: 1, lastDay: 2, lastMonth: 0, lastYear: 0,
    });
    assert.strictEqual(caps.meter_money_last_day, 2);
    caps.meter_money_this_month = 7;
    caps.meter = 123;
    const read = m.meterMoneyFromCapabilities('meter');
    assert.strictEqual(read.month, 7);
    assert.strictEqual(read.meterValue, 123);
    assert.strictEqual(read.lastDay, 2);

    // A restart waits for the running init, flushes, then starts again; not twice at once.
    let initDone;
    m.initRunning = new Promise((resolve) => {
      initDone = resolve;
    });
    const restart = m.restartDevice(1);
    await m.restartDevice(1);
    assert.deepStrictEqual(order, ['stopPolling', 'destroy']);
    initDone();
    await restart;
    assert.deepStrictEqual(order, ['stopPolling', 'destroy', 'flushStore', 'onInit']);
    // Deleted meanwhile: no new start.
    order.length = 0;
    m.restarting = false;
    m.isDestroyed = true;
    await m.restartDevice(1);
    assert.deepStrictEqual(order, ['stopPolling']);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
