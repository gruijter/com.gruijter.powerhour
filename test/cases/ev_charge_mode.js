/* eslint-disable no-console */

'use strict';

// Unit cases for the EV charge mode (drivers/evCharger/device.js setChargeMode() and its flow
// cards): four modes, each can be temporary. Run: node test/cases/ev_charge_mode.js

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
const EvDevice = require('../../drivers/evCharger/device');
const EvFlows = require('../../lib/flows/EvFlows');

let T = Date.UTC(2026, 10, 10, 12, 0, 0);
Date.now = () => T;
const H = 3600 * 1000;

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

// A charger in `mode`; settings: overrideMaxHours.
const charger = (mode = 'scheduled_price', settings = { overrideMaxHours: 4 }) => {
  const d = Object.create(EvDevice.prototype);
  Object.assign(d, {
    mode,
    tempMode: null,
    getCapabilityValue: (cap) => (cap === 'ev_charge_mode' ? d.mode : null),
    setCapabilityValue: async (cap, value) => {
      if (cap === 'ev_charge_mode') d.mode = value;
    },
    getSettings: () => settings,
    setStoreValue: async () => {},
    _updateResumeText: async () => {},
    updateChargeChart: async () => {},
    log: () => {},
    error: (err) => {
      throw err;
    },
  });
  d.flows = new EvFlows(d);
  return d;
};
// What the tile does (the capability listener in onInit()).
const tile = (d, value) => d.setChargeMode(value, 'set by user', { hours: ['fast_charge', 'off'].includes(value) ? d._tempHours() : 0 });

(async () => {
  await test('tile: Charge now and Don\'t charge end by themselves, Smart and Solar only stay', async () => {
    const d = charger('solar_only');
    await tile(d, 'fast_charge');
    assert.strictEqual(d.mode, 'fast_charge');
    assert.deepStrictEqual(d.tempMode, { since: T, previousMode: 'solar_only', hours: 4 });
    // To the other temporary mode: still back to the mode before both.
    await tile(d, 'off');
    assert.strictEqual(d.tempMode.previousMode, 'solar_only');
    assert.strictEqual(d._plannerMode('off'), 'solar_only'); // the plan shows what comes after
    assert.strictEqual(d._offUntilMs('off'), T + 4 * H);
    T += 3.9 * H;
    assert.strictEqual(await d._endTempModeIfDue(), false);
    T += 0.2 * H;
    assert.strictEqual(await d._endTempModeIfDue(), true);
    assert.strictEqual(d.mode, 'solar_only');
    assert.strictEqual(d.tempMode, null);
    await tile(d, 'scheduled_price');
    assert.strictEqual(d.tempMode, null);
  });

  await test('tile with setting 0: until changed', async () => {
    const d = charger('scheduled_price', { overrideMaxHours: 0 });
    await tile(d, 'off');
    assert.strictEqual(d.mode, 'off');
    assert.strictEqual(d.tempMode, null);
    assert.strictEqual(d._plannerMode('off'), 'off');
    assert.strictEqual(d._offUntilMs('off'), 0);
    // A switch by hand is still for a time (the default).
    assert.strictEqual(d._tempHours(true), 4);
  });

  await test('new flow card: any mode for minutes, 0 until changed', async () => {
    const d = charger('scheduled_price');
    await d.flows.set_ev_charge_mode_for({ mode: 'solar_only', duration: 90 });
    assert.strictEqual(d.mode, 'solar_only');
    assert.deepStrictEqual(d.tempMode, { since: T, previousMode: 'scheduled_price', hours: 1.5 });
    await d.flows.set_ev_charge_mode_for({ mode: 'fast_charge', duration: 0 });
    assert.strictEqual(d.mode, 'fast_charge');
    assert.strictEqual(d.tempMode, null);
  });

  await test('deprecated flow card: its former temporary values still work', async () => {
    const d = charger('scheduled_price', { overrideMaxHours: 2 });
    await d.flows.set_ev_charge_mode({ mode: 'charge_temp' });
    assert.strictEqual(d.mode, 'fast_charge');
    assert.strictEqual(d.tempMode.hours, 2);
    await d.flows.set_ev_charge_mode({ mode: 'off_temp' });
    assert.strictEqual(d.mode, 'off');
    assert.strictEqual(d.tempMode.previousMode, 'scheduled_price');
    await d.flows.set_ev_charge_mode({ mode: 'off' });
    assert.strictEqual(d.tempMode, null); // as before: until changed
    await assert.rejects(d.flows.set_ev_charge_mode({ mode: 'nonsense' }), /Unknown charge mode/);
    assert.strictEqual(d.mode, 'off');
  });

  await test('condition: a former temporary value matches its mode', async () => {
    const d = charger('fast_charge');
    assert.strictEqual(await d.flows.ev_charge_mode_is({ mode: 'charge_temp' }), true);
    assert.strictEqual(await d.flows.ev_charge_mode_is({ mode: 'fast_charge' }), true);
    assert.strictEqual(await d.flows.ev_charge_mode_is({ mode: 'off_temp' }), false);
    // A device not started since the update still holds the old value.
    d.mode = 'off_temp';
    assert.strictEqual(await d.flows.ev_charge_mode_is({ mode: 'off' }), true);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
