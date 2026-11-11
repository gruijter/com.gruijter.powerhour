/* eslint-disable no-console */

'use strict';

// Unit cases for the battery device warning (drivers/battery/device.js deviceWarning() and
// updateWarning()). Run: node test/cases/battery_warning.js

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
const BatDevice = require('../../drivers/battery/device');

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

const MIN = 60 * 1000;
const NO_GRID = 'warning_no_grid_monitor';

// A battery started at 0; shown: what Homey shows (null: no warning), writes: the calls made.
const battery = ({
  grid = false, mode = 'smart', shown = 'old warning', controlled = true,
} = {}) => {
  const d = Object.create(BatDevice.prototype);
  Object.assign(d, {
    initTm: 0,
    controlError: null,
    warningShown: undefined,
    grid,
    mode,
    shown,
    writes: 0,
    homey: {
      __: (key) => key,
      drivers: { getDriver: () => ({ getDevices: () => (d.grid ? [{ getImportHeadroomW: () => null }] : []) }) },
    },
    getBatteryMode: () => d.mode,
    isControlConfigured: () => controlled,
    setWarning: async (text) => {
      d.shown = text;
      d.writes += 1;
    },
    unsetWarning: async () => {
      d.shown = null;
      d.writes += 1;
    },
    error: () => {},
  });
  return d;
};

(async () => {
  await test('right after the start the warning is left as it is', async () => {
    const d = battery();
    await d.updateWarning(1 * MIN);
    assert.strictEqual(d.shown, 'old warning');
    assert.strictEqual(d.writes, 0);
  });

  await test('no Grid Monitor in a plan mode: warned, once', async () => {
    const d = battery();
    await d.updateWarning(3 * MIN);
    await d.updateWarning(4 * MIN);
    assert.strictEqual(d.shown, NO_GRID);
    assert.strictEqual(d.writes, 1);
  });

  await test('with a Grid Monitor an old warning is cleared, and it comes back without', async () => {
    const d = battery({ grid: true });
    await d.updateWarning(3 * MIN);
    assert.strictEqual(d.shown, null);
    d.grid = false;
    await d.updateWarning(4 * MIN);
    assert.strictEqual(d.shown, NO_GRID);
    d.grid = true;
    await d.updateWarning(5 * MIN);
    assert.strictEqual(d.shown, null);
  });

  await test('a forced mode does not follow the plan: no warning', async () => {
    for (const mode of ['xom', 'hold', 'idle', 'charge', 'discharge', 'device']) {
      const d = battery({ mode });
      await d.updateWarning(3 * MIN);
      assert.strictEqual(d.shown, null, mode);
    }
    const d = battery({ mode: 'self_consumption' });
    await d.updateWarning(3 * MIN);
    assert.strictEqual(d.shown, NO_GRID);
  });

  await test('a control error comes first, also right after the start', async () => {
    const d = battery();
    d.controlError = 'bat_control_failed';
    await d.updateWarning(1 * MIN);
    assert.strictEqual(d.shown, 'bat_control_failed');
    await d.clearControlWarning();
    assert.strictEqual(d.shown, NO_GRID); // clearControlWarning() uses the time now: past the start
  });

  await test('a battery this app does not control: no warning', async () => {
    const d = battery({ controlled: false });
    await d.updateWarning(3 * MIN);
    assert.strictEqual(d.shown, null);
  });

  await test('a control error fixed right after the start: cleared', async () => {
    const d = battery();
    d.controlError = 'bat_control_failed';
    await d.updateWarning(1 * MIN);
    d.controlError = null;
    await d.updateWarning(1.5 * MIN);
    assert.strictEqual(d.shown, null);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
