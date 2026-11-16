/* eslint-disable no-console */

'use strict';

// One contract year for the app (ContractYear): grid's start date, a meter at a time from Insights,
// and a device moving its month and year to a new start (MeterDeviceMixin.followContractStart).
// Run: node test/cases/contract_year.js

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
const ContractYear = require('../../lib/helpers/ContractYear');
const MeterDeviceMixin = require('../../lib/genericDeviceDrivers/MeterDeviceMixin');

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
const settingsStore = () => {
  const values = {};
  return {
    values,
    get: (k) => values[k],
    set: (k, v) => {
      values[k] = v;
    },
    unset: (k) => {
      delete values[k];
    },
  };
};
const homeyWith = (grids, settings = settingsStore()) => ({
  settings,
  drivers: { getDriver: () => ({ getDevices: () => grids }), getDrivers: () => ({}) },
  clock: { getTimezone: () => 'Europe/Amsterdam' },
});
const grid = (start) => ({ getSettings: () => ({ start_date: start }) });

// 6-hour buckets of a meter rising 1 kWh per hour, from t0.
const apiWith = (logs) => ({
  insights: {
    getLog: async ({ id }) => (logs[id] ? { id } : null),
    getLogEntries: async ({ id }) => logs[id],
  },
});
const rising = (t0, n) => ({
  step: 6 * HOUR,
  values: Array.from({ length: n }, (_, i) => ({ t: new Date(t0 + i * 6 * HOUR).toISOString(), v: 100 + (i * 6) + 3 })),
});

(async () => {
  await test('start date: grid, else the saved one, else 1 January', async () => {
    assert.strictEqual(ContractYear.startDate(homeyWith([grid('1503')])), '1503');
    const settings = settingsStore();
    settings.set('contractStart', '0107');
    assert.strictEqual(ContractYear.startDate(homeyWith([], settings)), '0107');
    assert.strictEqual(ContractYear.startDate(homeyWith([])), '0101');
  });

  await test('meter at a time: between bucket centres, else the next log', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const api = apiWith({ 'homey:device:d:meter_power': rising(t0, 400) });
    const ms = t0 + 30 * HOUR; // 30 h after the first bucket start
    const v = await ContractYear.meterAt(api, 'd', ['meter_power_hidden', 'meter_power'], ms);
    assert.ok(Math.abs(v - 130) < 1e-9, `got ${v}`);
    assert.strictEqual(await ContractYear.meterAt(api, 'd', ['meter_power'], t0 - HOUR), null);
    assert.strictEqual(await ContractYear.meterAt(api, 'd', ['meter_power'], t0 - HOUR, { orFirst: true }), 103);
  });

  await test('local midnight in UTC', async () => {
    assert.strictEqual(new Date(ContractYear.localStartMs(new Date(2026, 2, 15), 'Europe/Amsterdam')).toISOString(), '2026-03-14T23:00:00.000Z');
  });

  await test('a new start moves month and year to the meter at the new starts', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const store = { lastReadingMonth: { month: 10, year: 2026, meterValue: 5 }, lastReadingYear: { month: 0, year: 2026, meterValue: 1 } };
    const device = Object.assign(Object.create(MeterDeviceMixin), {
      homey: { ...homeyWith([grid('1503')]), app: { api: apiWith({ 'homey:device:d:meter_power': rising(t0, 1400) }) } },
      driver: { id: 'power', ds: { energyCaps: { meter_power: 'meter_power_hidden' } } },
      ds: { cmap: { meter_source: 'meter_power_hidden' } },
      getId: () => 'd',
      getName: () => 'Meter',
      log: () => {},
      error: () => {},
      getSettings: () => ({ start_date: '0101' }),
      getStoreValue: (k) => store[k],
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
    });
    await device.followContractStart();
    assert.strictEqual(device.startDay, 15);
    assert.strictEqual(device.startMonth, 2);
    assert.strictEqual(store.contractStart, '1503');
    const yearStart = ContractYear.localStartMs(new Date(2026, 2, 15), 'Europe/Amsterdam');
    assert.ok(Math.abs(store.lastReadingYear.meterValue - (100 + (yearStart - t0) / HOUR)) < 1e-6);
    assert.strictEqual(store.lastReadingYear.month, 2);
    // Same start again: nothing moves.
    store.lastReadingYear.meterValue = 7;
    await device.followContractStart();
    assert.strictEqual(store.lastReadingYear.meterValue, 7);
  });

  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
