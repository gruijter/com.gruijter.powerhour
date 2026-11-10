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
  await helper.register(callback);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  helper.unregister(callback);
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

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
