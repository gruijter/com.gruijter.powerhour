/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/FlowPairs.js: per moment each source feeds each destination in
// proportion; a battery never charges itself; the day sums what was recorded.
// Run: node test/cases/flow_pairs.js

const assert = require('assert');
const FileStore = require('../../lib/helpers/FileStore');
const FlowPairs = require('../../lib/helpers/FlowPairs');

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
const near = (a, b) => Math.abs(a - b) < 1e-6;

(async () => {
  await test('proportional per moment, nothing to itself', async () => {
    const p = FlowPairs.split({
      grid: 1000, solar: 1000, battery: 500, ev: 0,
    });
    assert.ok(near(p.grid_battery, 250) && near(p.solar_battery, 250), JSON.stringify(p));
    assert.ok(near(p.grid_home, 750) && near(p.solar_home, 750));
    assert.ok(near(p.battery_battery, 0) && near(p.grid_export, 0));
  });

  await test('discharging battery feeds home and export, not the EV charging at night', async () => {
    const dev = {
      flowPairs: null, timeZone: 'Europe/Amsterdam', homey: { clock: { getTimezone: () => 'Europe/Amsterdam' } }, error: () => {},
    };
    const t0 = Date.now() - 3 * 60 * 1000;
    FlowPairs.record(dev, t0, {
      grid: 7400, solar: 0, battery: 0, ev: 7000,
    });
    FlowPairs.record(dev, t0 + 60000, {
      grid: 0, solar: 0, battery: -600, ev: 0,
    });
    FlowPairs.record(dev, t0 + 120000, {
      grid: 0, solar: 0, battery: 0, ev: 0,
    });
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    const m = FlowPairs.period(dev, 'day');
    assert.ok(m && m.grid.ev > 0.11 && m.battery.ev === 0, JSON.stringify(m));
    assert.ok(m.battery.home > 0.009, JSON.stringify(m.battery));
  });

  console.log(failed ? `${failed} failed` : 'all passed');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
