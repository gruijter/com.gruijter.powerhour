/* eslint-disable no-console */

'use strict';

// Calendar periods and the contract year of a main meter (ContractYear): a meter at a time from
// Insights, an older year start moving once (MeterDeviceMixin.followPeriodStarts), the contract counter.
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
const SumDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const MeterHelpers = require('../../lib/helpers/MeterHelpers');

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

// 6-hour buckets of a meter rising 1 kWh per hour, from t0.
const apiWith = (logs) => ({
  insights: {
    getLog: async ({ id }) => (logs[id] ? { id } : null),
    getLogEntries: async ({ id, resolution }) => (resolution === 'lastYear' ? null : logs[id]),
  },
});
const rising = (t0, n) => ({
  step: 6 * HOUR,
  values: Array.from({ length: n }, (_, i) => ({ t: new Date(t0 + i * 6 * HOUR).toISOString(), v: 100 + (i * 6) + 3 })),
});

(async () => {
  await test('contract start: main meters only, not on 1 January', async () => {
    assert.strictEqual(ContractYear.contractStart('grid', { start_date: '0107' }), '0107');
    assert.strictEqual(ContractYear.contractStart('gas', { start_date: '0101' }), null);
    assert.strictEqual(ContractYear.contractStart('solar', { start_date: '0107' }), null);
    const r = (y, m, d) => ({ year: y, month: m, day: d });
    assert.strictEqual(ContractYear.isNewContract(r(2026, 6, 1), r(2026, 5, 30), '0107'), true);
    assert.strictEqual(ContractYear.isNewContract(r(2026, 6, 1), r(2026, 6, 1), '0107'), false);
    assert.strictEqual(ContractYear.isNewContract(r(2026, 5, 30), r(2025, 6, 1), '0107'), false);
    assert.strictEqual(ContractYear.isNewContract(r(2026, 6, 1), r(2026, 5, 30), null), false);
  });

  await test('meter at a time: between bucket centres, else the next log', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const api = apiWith({ 'homey:device:d:meter_power': rising(t0, 400) });
    const ms = t0 + 30 * HOUR; // 30 h after the first bucket start
    const v = await ContractYear.meterAt(api, 'd', ['meter_power_hidden', 'meter_power'], ms);
    assert.ok(Math.abs(v - 130) < 1e-9, `got ${v}`);
    // Within a step before the first point (a year start at the start of a range): that point.
    assert.strictEqual(await ContractYear.meterAt(api, 'd', ['meter_power'], t0 - HOUR), 103);
    assert.strictEqual(await ContractYear.meterAt(api, 'd', ['meter_power'], t0 - 7 * HOUR), null);
    assert.strictEqual(await ContractYear.meterAt(api, 'd', ['meter_power'], t0 - 7 * HOUR, { orFirst: true }), 103);
  });

  await test('local midnight in UTC', async () => {
    assert.strictEqual(new Date(ContractYear.localStartMs(new Date(2026, 2, 15), 'Europe/Amsterdam')).toISOString(), '2026-03-14T23:00:00.000Z');
  });

  await test('an older year start moves once to the calendar; a main meter keeps it as contract year', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const run = async (driverId, startDate) => {
      const store = { lastReadingMonth: { month: 10, year: 2026, meterValue: 5 }, lastReadingYear: { month: 2, year: 2026, meterValue: 1 } };
      const calls = [];
      const device = Object.assign(Object.create(MeterDeviceMixin), {
        homey: { ...homeyWith([]), app: { api: apiWith({ 'homey:device:d:meter_power': rising(t0, 1400) }) } },
        driver: { id: driverId, ds: { energyCaps: { meter_power: 'meter_power_hidden' } } },
        ds: { cmap: { meter_source: 'meter_power_hidden' } },
        getId: () => 'd',
        getName: () => 'Meter',
        log: () => {},
        error: () => {},
        hasCapability: () => false,
        getSettings: () => ({ start_date: startDate }),
        getStoreValue: (k) => store[k],
        setStoreValue: async (k, v) => {
          store[k] = v;
        },
        unsetStoreValue: async (k) => {
          delete store[k];
        },
        keepYearAsContract: async () => calls.push(`keep ${store.lastReadingYear.month}`),
        followContract: async () => calls.push('contract'),
      });
      await device.followPeriodStarts();
      return { device, store, calls };
    };
    const { device, store, calls } = await run('power', '1503');
    assert.deepStrictEqual([device.startDay, device.startMonth, device.contractStart], [1, 0, null]);
    assert.strictEqual(store.periodStart, '0101');
    // 1 January (local) is within a step before the first bucket: its value.
    assert.strictEqual(store.lastReadingYear.meterValue, 103);
    assert.strictEqual(store.lastReadingYear.month, 0);
    const monthStart = ContractYear.localStartMs(new Date(2026, 10, 1), 'Europe/Amsterdam');
    assert.ok(Math.abs(store.lastReadingMonth.meterValue - (100 + (monthStart - t0) / HOUR)) < 1e-6);
    assert.deepStrictEqual(calls, ['contract']);
    // Once: a later start changes nothing.
    store.lastReadingYear.meterValue = 7;
    await device.followPeriodStarts();
    assert.strictEqual(store.lastReadingYear.meterValue, 7);
    // A gas meter with that start: its year (before the move) becomes the contract year.
    const gas = await run('gas', '1503');
    assert.strictEqual(gas.device.contractStart, '1503');
    assert.deepStrictEqual(gas.calls, ['keep 2', 'contract']);
  });

  await test('Insights jobs run one at a time, also after a failing one', async () => {
    const order = [];
    const job = (name, ms, fail) => () => new Promise((resolve, reject) => {
      order.push(`${name}+`);
      setTimeout(() => {
        order.push(`${name}-`);
        if (fail) reject(Error(name));
        else resolve(name);
      }, ms);
    });
    const runs = [ContractYear.serial(job('a', 20)), ContractYear.serial(job('b', 5, true)).catch(() => 'x'), ContractYear.serial(job('c', 1))];
    assert.deepStrictEqual(await Promise.all(runs), ['a', 'x', 'c']);
    assert.deepStrictEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });

  await test('money after a rebase: energy part scaled with the kWh, fixed costs since the new start', async () => {
    const caps = { meter_money_this_month: 20, meter_money_this_year: 100 };
    const store = { fixedMoney: { month: 2, year: 10 } };
    const dev = Object.assign(Object.create(null), MeterDeviceMixin, {
      driver: { id: 'power' },
      meterMoney: { meterValue: 1000, month: 20, year: 100 },
      lastReadingMonth: { meterValue: 950 },
      lastReadingYear: { meterValue: 600 },
      hasCapability: (c) => c in caps,
      setCapability: async (c, v) => {
        caps[c] = v;
      },
      getStoreValue: (k) => store[k],
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      estimateFixedMoney: () => ({ month: 1, year: 12 }),
      getName: () => 'Meter',
      log: () => {},
    });
    dev.fixedMoney = store.fixedMoney;
    await dev.rebaseMoney({ month: { meterValue: 900 }, year: { meterValue: 600 } });
    // Month: (20 - 2) * 50/100 + 1; year: base unchanged, money kept.
    assert.strictEqual(caps.meter_money_this_month, 10);
    assert.strictEqual(caps.meter_money_this_year, 100);
    assert.deepStrictEqual(store.fixedMoney, { month: 1, year: 10 });
  });

  await test('contract year: counts from its start, rolls over on the start day, money too', async () => {
    const caps = {};
    const store = {};
    const dev = Object.assign(Object.create(SumDevice.prototype), {
      ds: { cmap: { this_contract: 'meter_m3_this_contract', last_contract: 'meter_m3_last_contract' } },
      contractStart: '0107',
      lastReadingContract: {
        year: 2025, month: 6, day: 1, meterValue: 100,
      },
      hasCapability: () => true,
      getCapabilityValue: (c) => caps[c],
      setCapabilityValue: async (c, v) => {
        caps[c] = v;
      },
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      error: (e) => {
        throw e;
      },
    });
    const r1 = {
      year: 2026, month: 5, day: 30, meterValue: 150,
    };
    await dev.updateContractMeter(r1, { newContract: ContractYear.isNewContract(r1, dev.lastReadingContract, '0107') });
    assert.strictEqual(caps.meter_m3_this_contract, 50);
    const r2 = {
      year: 2026, month: 6, day: 1, meterValue: 151,
    };
    await dev.updateContractMeter(r2, { newContract: ContractYear.isNewContract(r2, dev.lastReadingContract, '0107') });
    assert.deepStrictEqual([caps.meter_m3_last_contract, caps.meter_m3_this_contract, store.lastReadingContract.meterValue], [51, 0, 151]);
    const money = MeterHelpers.calculateMoney({
      day: 0, month: 0, year: 0, contract: 10, meterValue: 150,
    }, r2, 2);
    assert.strictEqual(money.contract, 12);
    await dev.rollMoneyPeriods(money, { newContract: true });
    assert.deepStrictEqual([money.lastContract, money.contract, caps.meter_money_last_contract], [12, 0, 12]);
    assert.strictEqual(MeterHelpers.calculateMoney({ day: 0, meterValue: 1 }, r2, 2).contract, undefined);
  });

  await test('meter at a time two years back: last2Years weeks, only before the finer points', async () => {
    const year = new Date().getUTCFullYear();
    const week = 7 * 24 * HOUR;
    const t2 = Date.UTC(year - 2, 0, 1);
    const t1 = Date.UTC(year - 1, 0, 1);
    const linear = (t) => (t - t2) / HOUR; // 1 kWh per hour
    const data = {
      last2Years: { step: week, values: Array.from({ length: 104 }, (_, i) => ({ t: new Date(t2 + i * week).toISOString(), v: linear(t2 + i * week + week / 2) + (t2 + i * week >= t1 ? 1000 : 0) })) },
      lastYear: { step: 6 * HOUR, values: Array.from({ length: 1460 }, (_, i) => ({ t: new Date(t1 + i * 6 * HOUR).toISOString(), v: linear(t1 + i * 6 * HOUR + 3 * HOUR) })) },
      thisYear: { step: 6 * HOUR, values: [] },
    };
    const asked = [];
    const api = {
      insights: {
        getLog: async () => ({ id: 'x' }),
        getLogEntries: async ({ resolution }) => {
          asked.push(resolution);
          return data[resolution];
        },
      },
    };
    const ms = Date.UTC(year - 2, 5, 1);
    assert.ok(Math.abs(await ContractYear.meterAt(api, 'd', ['meter_power'], ms) - linear(ms)) < 1e-6);
    assert.deepStrictEqual(asked, ['thisYear', 'lastYear', 'last2Years']);
    // In last year: the 6-hour points, the overlapping (wrong) weeks are dropped.
    const ms1 = Date.UTC(year - 1, 5, 1);
    assert.ok(Math.abs(await ContractYear.meterAt(api, 'd', ['meter_power'], ms1) - linear(ms1)) < 1e-6);
  });

  await test('re-anchor and source switch move the contract start too', async () => {
    const store = {};
    const reading = (v) => ({ meterValue: v });
    const dev = Object.assign(Object.create(SumDevice.prototype), {
      lastReadingHour: reading(19990),
      lastReadingDay: reading(19980),
      lastReadingMonth: reading(19900),
      lastReadingYear: reading(19000),
      lastReadingContract: reading(18000),
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      error: (e) => {
        throw e;
      },
    });
    await dev.reanchorBaselines(50);
    assert.strictEqual(store.lastReadingContract.meterValue, 50);
    dev.lastReadingContract = reading(18000);
    await MeterHelpers.shiftBaselines(dev, -15000);
    assert.strictEqual(dev.lastReadingContract.meterValue, 3000);
  });

  await test('contract money: NaN heals like the other periods', async () => {
    const money = MeterHelpers.calculateMoney({
      day: 0, month: 0, year: 0, contract: NaN, meterValue: 10,
    }, { meterValue: 11 }, 2);
    assert.strictEqual(money.contract, 2);
  });

  await test('contract money after a new start: kWh since money counts, markups since the start', async () => {
    const caps = { meter_power: 1000 };
    const store = { moneySince: 800, fixedMoney: { month: 1, year: 10 } };
    const dev = Object.assign(Object.create(SumDevice.prototype), {
      ds: { cmap: { meter_source: 'meter_power' } },
      meterMoney: { year: 110 },
      lastReadingYear: { meterValue: 500 },
      lastReadingContract: { meterValue: 900 },
      getCapabilityValue: (c) => caps[c],
      getStoreValue: (k) => store[k],
      fixedMoneySince: () => 4,
    });
    // Year energy 100 over 200 kWh (since 800); contract 100 kWh: 50, plus 4 markups.
    assert.strictEqual(dev.contractMoney(), 54);
    // Both starts before pairing: the year's energy money.
    dev.lastReadingContract = { meterValue: 700 };
    assert.strictEqual(dev.contractMoney(), 104);
  });

  await test('grid contract money: import and export each scaled with their own kWh', async () => {
    const GridDevice = require('../../drivers/grid/device');
    const dev = Object.assign(Object.create(GridDevice.prototype), {
      ds: { cmap: { meter_source: 'meter_power' } },
      getCapabilityValue: () => 50,
      getStoreValue: () => undefined,
      fixedMoney: { month: 0, year: 0 },
      lastReadingYear: { meterValue: 0 },
      lastReadingContract: { meterValue: 40 },
      directionalMeter: { importValue: 1000, exportValue: 950 },
      lastDirectionalReadingYear: { importValue: 0, exportValue: 0 },
      lastDirectionalReadingContract: { importValue: 500, exportValue: 600 },
      splitMoney: { year: { imported: 300, exported: 95 } },
    });
    // Net year money 205; contract: 300 * 0.5 - 95 * 350/950 = 115.
    assert.ok(Math.abs(dev.contractEnergyMoney(205) - 115) < 1e-9);
  });

  await test('calendar move: last month and year kWh from Insights, money scaled with them', async () => {
    const caps = {
      meter_kwh_last_month: 200, meter_kwh_last_year: 2000, meter_money_last_month: 50, meter_money_last_year: 500,
    };
    const dev = Object.assign(Object.create(null), MeterDeviceMixin, {
      driver: { id: 'power' },
      ds: { cmap: { last_month: 'meter_kwh_last_month', last_year: 'meter_kwh_last_year', meter_source: 'meter_power' } },
      meterMoney: { lastMonth: 50, lastYear: 500 },
      timeZone: 'Europe/Amsterdam',
      hasCapability: (c) => c in caps,
      getCapabilityValue: (c) => caps[c],
      setCapability: async (c, v) => {
        caps[c] = v;
      },
      getSettings: () => ({ markup_month: 10 }),
    });
    await dev.rebaseLastPeriods({ month: 100, year: 3000 });
    assert.deepStrictEqual([caps.meter_kwh_last_month, caps.meter_kwh_last_year], [100, 3000]);
    // Month: (50 - 10) * 0.5 + 10; year: (500 - 120) * 1.5 + 120.
    assert.deepStrictEqual([caps.meter_money_last_month, caps.meter_money_last_year], [30, 690]);
  });

  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
