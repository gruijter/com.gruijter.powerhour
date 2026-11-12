/* eslint-disable no-console */

'use strict';

// Unit cases for the order at a price slot boundary: the consumers' new tariff first, once per
// slot (app.slotTariffs()), then the price devices' period triggers (generic_price_driver).
// Run: node test/cases/slot_tariffs.js

const assert = require('assert');
const Module = require('module');

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
const App = require('../../app');
const PriceDriver = require('../../lib/genericDeviceDrivers/generic_price_driver');

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

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// An app with consumer drivers whose tariff step takes tickMs and is logged.
const fakeApp = (events, tickMs = 30) => {
  const app = Object.create(App.prototype);
  const consumer = (id) => ({
    async priceSlotTick() {
      events.push(`${id} start`);
      await wait(tickMs);
      events.push(`${id} done`);
    },
  });
  app.homey = {
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    drivers: { getDrivers: () => ({ battery: consumer('battery'), power: consumer('power'), price: {} }) },
  };
  app.error = (err) => {
    throw err;
  };
  return app;
};

(async () => {
  await test('the tariff step runs once per slot, one driver after the other', async () => {
    const events = [];
    const app = fakeApp(events);
    const a = app.slotTariffs();
    const b = app.slotTariffs(); // a second driver's listener at the same boundary
    assert.strictEqual(a, b);
    await a;
    assert.deepStrictEqual(events, ['battery start', 'battery done', 'power start', 'power done']);
  });

  await test('price devices fire their period triggers after the new tariffs', async () => {
    const events = [];
    const app = fakeApp(events);
    const driver = Object.create(PriceDriver.prototype);
    // The wait cap never fires here: the tariffs come first.
    driver.homey = { app, setTimeout: () => null, clearTimeout: () => {} };
    await driver.slotTariffsFirst();
    events.push('price triggers');
    assert.deepStrictEqual(events.slice(-2), ['power done', 'price triggers']);
  });

  await test('a hanging tariff step does not hold the price triggers forever', async () => {
    const events = [];
    const app = fakeApp(events);
    app.slotTariffs = () => new Promise(() => {});
    const driver = Object.create(PriceDriver.prototype);
    const timers = [];
    // The wait cap (SLOT_TARIFF_WAIT_MS) at once: setTimeoutPromise() uses homey.setTimeout.
    driver.homey = {
      app,
      setTimeout: (fn) => {
        timers.push(fn);
        fn();
      },
      clearTimeout: () => {},
    };
    await driver.slotTariffsFirst();
    assert.strictEqual(timers.length, 1);
  });

  Module._load = origLoad;
  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
