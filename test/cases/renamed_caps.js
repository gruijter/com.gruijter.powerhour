/* eslint-disable no-console */

'use strict';

// Renamed capabilities: value carried across the migration, flow notice on the old ones.
// Run: node test/cases/renamed_caps.js

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
const GenericSumDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const MigrationNotice = require('../../lib/helpers/MigrationNotice');

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

const RENAMED = { measure_power: 'measure_watt_solar', meter_power: 'meter_power_hidden' };

const makeDevice = (caps, store = {}) => {
  const device = Object.create(GenericSumDevice.prototype);
  const values = { ...caps };
  Object.assign(device, {
    driver: { renamedCapsFor: () => RENAMED },
    store: { ...store },
    values,
    log: () => {},
    error: () => {},
    getName: () => 'Solar',
    getSettings: () => ({}),
    hasCapability: (cap) => cap in values,
    getCapabilityValue: (cap) => (cap in values ? values[cap] : null),
    setCapabilityValue: async (cap, value) => {
      values[cap] = value;
    },
    getStoreValue: (key) => device.store[key],
    setStoreValue: async (key, value) => {
      device.store[key] = value;
    },
    unsetStoreValue: async (key) => {
      delete device.store[key];
    },
  });
  return device;
};

// The migration: old ones removed, new ones added without a value.
const migrateCaps = (device) => {
  Object.entries(RENAMED).forEach(([from, to]) => {
    delete device.values[from];
    device.values[to] = null;
  });
};

(async () => {
  await test('meter value moves to the new capability', async () => {
    const device = makeDevice({ measure_power: 120, meter_power: 2538.193 });
    await device.keepRenamedValues();
    migrateCaps(device);
    await device.restoreRenamedValues();
    assert.strictEqual(device.values.meter_power_hidden, 2538.193);
    assert.strictEqual(device.values.measure_watt_solar, 120);
    assert.strictEqual(device.store.renamedValues, undefined);
    assert.deepStrictEqual(device.store.renamedCaps, ['measure_power', 'meter_power']);
  });

  await test('interrupted migration restores at the next start', async () => {
    const device = makeDevice({ measure_power: 0, meter_power: 3316.5 });
    await device.keepRenamedValues();
    migrateCaps(device); // aborted before restore
    await device.keepRenamedValues(); // next start: old ones gone
    await device.restoreRenamedValues();
    assert.strictEqual(device.values.meter_power_hidden, 3316.5);
  });

  await test('a new value is not overwritten', async () => {
    const device = makeDevice({ meter_power_hidden: 5 }, { renamedValues: { meter_power_hidden: 3 } });
    await device.restoreRenamedValues();
    assert.strictEqual(device.values.meter_power_hidden, 5);
  });

  await test('power: virtual meters keep meter_power', async () => {
    const PowerDriver = require('../../drivers/power/driver'); // eslint-disable-line global-require
    const driver = Object.create(PowerDriver.prototype);
    driver.ds = { deviceCapabilities: ['meter_tariff', 'meter_power', 'measure_watt_avg'] };
    const real = { source_device_type: 'Homey device' };
    const flow = { source_device_type: 'virtual via flow' };
    const watt = { source_device_type: 'Homey device', use_measure_source: true };
    assert.deepStrictEqual(driver.capabilitiesFor(real), ['meter_tariff', 'meter_power_hidden', 'measure_watt_avg']);
    assert.deepStrictEqual(driver.capabilitiesFor(flow), [...driver.ds.deviceCapabilities, 'virtual_meter']);
    assert.deepStrictEqual(driver.capabilitiesFor(watt), driver.ds.deviceCapabilities);
    assert.deepStrictEqual(driver.renamedCapsFor(real), { meter_power: 'meter_power_hidden' });
    assert.deepStrictEqual(driver.renamedCapsFor(flow), { meter_power_hidden: 'meter_power' });
  });

  await test('notice only for flows on the old capabilities', async () => {
    const notes = [];
    const solar = makeDevice({}, { renamedCaps: ['measure_power', 'meter_power'] });
    solar.getData = () => ({ id: 'd1' });
    const other = makeDevice({}, { renamedCaps: ['measure_power', 'meter_power'] });
    other.getData = () => ({ id: 'd2' });
    const flows = {
      a: { name: 'Old trigger', trigger: { id: 'homey:device:S1:measure_power_changed' } },
      b: { name: 'Old tag', actions: [{ args: { text: '[[homey:device:S1|meter_power]]' } }] },
      c: { name: 'New tag', actions: [{ args: { text: '[[homey:device:S2|meter_power_hidden]]' } }] },
      d: { name: 'Sub meter', actions: [{ args: { text: '[[homey:device:S2|meter_power.peak]]' } }] },
    };
    const homey = {
      app: {
        log: () => {},
        error: () => {},
        api: {
          devices: {
            getDevices: async () => ({
              S1: { id: 'S1', data: { id: 'd1' }, driverId: 'homey:app:com.gruijter.powerhour:solar' },
              S2: { id: 'S2', data: { id: 'd2' }, driverId: 'homey:app:com.gruijter.powerhour:solar' },
            }),
          },
          flow: { getFlows: async () => flows, getAdvancedFlows: async () => ({}) },
        },
      },
      drivers: { getDrivers: () => ({ solar: { getDevices: () => [solar, other] } }) },
      notifications: { createNotification: async ({ excerpt }) => notes.push(excerpt) },
      __: (key, t) => `${key} ${t.device} ${t.flows}`,
    };
    await new MigrationNotice(homey).notifyRenamedCaps();
    assert.deepStrictEqual(notes, ["migration_renamed_caps Solar 'Old tag', 'Old trigger'"]);
    assert.ok(solar.store.renamedCaps);
    assert.strictEqual(other.store.renamedCaps, undefined);
  });

  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
