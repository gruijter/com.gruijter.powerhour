/* eslint-disable no-console */

'use strict';

// Unit cases for a source device switch: MeterHelpers.sourceSwitched()/shiftBaselines() and the
// summarizer's continueFromNewSource(). Run: node test/cases/source_switch.js

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
const MeterHelpers = require('../../lib/helpers/MeterHelpers');
const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');

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

// A summarizer on meter value 1000: this hour 1, day 10, month 100, year 500.
const fakeDevice = (settings = {}, store = {}) => {
  const caps = { meter_power: 1000, meter_kwh_last_hour: 0.5, meter_kwh_last_day: 8 };
  const device = Object.create(GenericDevice.prototype);
  Object.assign(device, {
    ds: { cmap: { meter_source: 'meter_power', last_hour: 'meter_kwh_last_hour', last_day: 'meter_kwh_last_day' } },
    store: { ...store },
    caps,
    getName: () => 'test',
    log: () => {},
    error: () => {},
    getSettings: () => ({ source_device_type: 'Homey device', homey_device_id: 'a', ...settings }),
    getStoreValue(key) {
      return this.store[key];
    },
    async setStoreValue(key, value) {
      this.store[key] = value;
    },
    getCapabilityValue(cap) {
      return this.caps[cap];
    },
    async setCapability(cap, value) {
      this.caps[cap] = value;
    },
    lastReadingHour: { meterValue: 999 },
    lastReadingDay: { meterValue: 990 },
    lastReadingMonth: { meterValue: 900 },
    lastReadingYear: { meterValue: 500 },
    meterMoney: { meterValue: 1000, day: 2 },
  });
  return device;
};

(async () => {
  await test('sourceSwitched: first start stores the key, a new source is a switch once', async () => {
    const device = fakeDevice();
    assert.strictEqual(await MeterHelpers.sourceSwitched(device, ['sourceCaps']), false);
    assert.strictEqual(await MeterHelpers.sourceSwitched(device, ['sourceCaps']), false);
    device.getSettings = () => ({ source_device_type: 'Homey device', homey_device_id: 'b' });
    assert.strictEqual(await MeterHelpers.sourceSwitched(device, ['sourceCaps']), true);
    assert.strictEqual(await MeterHelpers.sourceSwitched(device, ['sourceCaps']), false);
  });

  await test('sourceSwitched: other source capabilities of the same device are a switch', async () => {
    const device = fakeDevice({}, { sourceCaps: { caps: { p1: 'meter_power.imported' } } });
    await MeterHelpers.sourceSwitched(device, ['sourceCaps']);
    device.store.sourceCaps = { caps: { p1: 'meter_power' } };
    assert.strictEqual(await MeterHelpers.sourceSwitched(device, ['sourceCaps']), true);
  });

  await test('continueFromNewSource: totals and money go on from the new meter', async () => {
    const device = fakeDevice();
    device.shiftNextReading = true;
    await device.continueFromNewSource(25000);
    const delta = 24000;
    assert.strictEqual(device.lastReadingHour.meterValue, 999 + delta);
    assert.strictEqual(device.lastReadingYear.meterValue, 500 + delta);
    assert.strictEqual(device.store.lastReadingDay.meterValue, 990 + delta);
    assert.strictEqual(25000 - device.lastReadingDay.meterValue, 10); // day total kept
    assert.strictEqual(device.meterMoney.meterValue, 25000); // no money for the difference
    assert.strictEqual(device.caps.meter_power, 25000);
    assert.strictEqual(device.shiftNextReading, false);
    await device.checkMeterJump(25000.1); // no anomaly held after the switch
  });

  await test('continueFromNewSource: a lower new meter shifts down', async () => {
    const device = fakeDevice();
    await device.continueFromNewSource(3);
    assert.strictEqual(3 - device.lastReadingMonth.meterValue, 100);
  });

  Module._load = origLoad;
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
