/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/EnergyPollingHelper.js: the live report is only fetched when a driver
// needs it. Run: node test/cases/energy_polling.js

const assert = require('assert');
const helper = require('../../lib/helpers/EnergyPollingHelper');

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

// gridW: measure_watt_grid of the Grid Monitor (undefined: no grid device); solar: Solar Monitors.
const state = { gridW: undefined, solar: 0, calls: 0 };
const homey = {
  setTimeout: () => 1, // the next poll is not run
  clearTimeout: () => {},
  clearInterval: () => {},
  app: {
    api: {
      energy: {
        getLiveReport: async () => {
          state.calls += 1;
          return { totalCumulative: { W: 123 } };
        },
      },
    },
  },
  drivers: {
    getDriver: (id) => {
      if (id === 'grid') return { getDevices: () => (state.gridW === undefined ? [] : [{ getCapabilityValue: () => state.gridW }]) };
      if (id === 'solar') return { getDevices: () => new Array(state.solar).fill({}) };
      throw new Error('driver not ready');
    },
  },
};
const logger = { log: () => {}, error: () => {} };

// One poll with this setup: the report the callbacks got, and whether it was fetched.
const pollOnce = async (setup) => {
  Object.assign(state, { gridW: undefined, solar: 0, calls: 0 }, setup);
  let got;
  const callback = async (report) => {
    got = report;
  };
  // A grid driver, which asks for the report without a Solar Monitor (GridDriver.needsEnergyReport()).
  const grid = { needsEnergyReport: () => state.solar === 0 };
  helper.drivers.add(grid);
  await helper.register(callback);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  helper.unregister(callback);
  helper.drivers.delete(grid);
  return { report: got, calls: state.calls };
};

(async () => {
  helper.init(homey, logger);

  await test('the logger of the first driver is used', async () => {
    assert.strictEqual(helper.logger, logger);
    helper.init(homey, { log: () => {}, error: () => {} });
    assert.strictEqual(helper.logger, logger);
  });

  await test('no Grid Monitor: the report is fetched', async () => {
    const r = await pollOnce({ solar: 1 });
    assert.strictEqual(r.calls, 1);
    assert.strictEqual(r.report.totalCumulative.W, 123);
  });

  await test('a Grid Monitor without a reading yet: fetched', async () => {
    assert.strictEqual((await pollOnce({ gridW: null, solar: 1 })).calls, 1);
  });

  await test('a Grid Monitor without a Solar Monitor: fetched (solar power from the report)', async () => {
    assert.strictEqual((await pollOnce({ gridW: 400, solar: 0 })).calls, 1);
  });

  await test('a Grid Monitor and a Solar Monitor: not fetched, the callbacks still run', async () => {
    const r = await pollOnce({ gridW: 0, solar: 2 });
    assert.strictEqual(r.calls, 0);
    assert.strictEqual(r.report, null);
  });

  await test('a driver with onEnergyReport() gets the poll, with the grid power; one without does not', async () => {
    Object.assign(state, { gridW: -800, solar: 1, calls: 0 });
    const seen = [];
    const driver = {
      homey, log: () => {}, error: () => {}, onEnergyReport: async (report) => seen.push(await helper.gridPowerW(report)),
    };
    await helper.startFor(driver);
    await helper.startFor(driver); // once
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.deepStrictEqual(seen, [-800]);
    helper.stopFor(driver);
    assert.strictEqual(driver.energyPollCallback, null);
    assert.strictEqual(helper.callbacks.size, 0);
    const plain = { homey, log: () => {}, error: () => {} };
    await helper.startFor(plain);
    assert.strictEqual(plain.energyPollCallback, undefined);
    // Without a Grid Monitor: Homey Energy's grid power from the report.
    state.gridW = undefined;
    assert.strictEqual(await helper.gridPowerW({ totalCumulative: { W: 123 } }), 123);
    assert.strictEqual(await helper.gridPowerW(null), undefined);
    // Beyond the plausibility ceiling (2 x the default connection): none.
    assert.strictEqual(await helper.gridPowerW({ totalCumulative: { W: 500000 } }), undefined);
    assert.strictEqual(await helper.gridPowerW({ totalCumulative: { W: -500000 } }), undefined);
  });

  await test('every driver that uses the grid power takes the poll (the EV charger too)', async () => {
    const Module = require('module'); // eslint-disable-line global-require
    const origLoad = Module._load;
    Module._load = function load(request, ...rest) {
      if (request === 'homey') {
        class Base {}
        return {
          Device: Base, Driver: Base, App: Base, SimpleClass: Base, env: {},
        };
      }
      return origLoad.call(this, request, ...rest);
    };
    state.gridW = -1500;
    const GridDriver = require('../../drivers/grid/driver'); // eslint-disable-line global-require
    const gridDriver = Object.assign(Object.create(GridDriver.prototype), { homey });
    state.solar = 0;
    assert.strictEqual(gridDriver.needsEnergyReport(), true);
    state.solar = 1;
    assert.strictEqual(gridDriver.needsEnergyReport(), false);
    for (const id of ['evCharger', 'power', 'solar']) {
      const Driver = require(`../../drivers/${id}/driver`); // eslint-disable-line global-require, import/no-dynamic-require
      const device = { getCapabilityValue: () => 1000 };
      const driver = Object.assign(Object.create(Driver.prototype), { homey, getDevices: () => [device] });
      assert.strictEqual(typeof driver.onEnergyReport, 'function', id);
      assert.strictEqual(typeof driver.checkStartPolling, 'function', id);
      await driver.onEnergyReport(null);
      assert.strictEqual(device.currentGridPower, -1500, id);
    }
    Module._load = origLoad;
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
