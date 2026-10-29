/* eslint-disable no-console */

'use strict';

// Unit cases for the fixed tariff (tariff group 0, no Energy Price device): the setup view in
// lib/helpers/PairSetup.js and applyFixedTariff() of the meters. Run: node test/cases/fixed_tariff.js

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
const PairSetup = require('../../lib/helpers/PairSetup');
const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const SumFlows = require('../../lib/flows/SumFlows');

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

const setting = (id) => ({
  id, type: 'number', label: { en: id }, value: id === 'tariff_update_group' ? 1 : 0,
});

// A power driver in Amsterdam, with price devices { group: name } of commodity power.
const fakeDriver = (priceDevices = {}) => {
  const prices = Object.entries(priceDevices).map(([group, name]) => ({
    getName: () => name,
    getSettings: () => ({ tariff_update_group: Number(group), commodity: 'power' }),
  }));
  const homey = {
    __: (key) => key,
    i18n: { getLanguage: () => 'en' },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    geolocation: { getLatitude: () => 52.37, getLongitude: () => 4.9 },
    drivers: {
      getDriver: (id) => {
        if (id !== 'price') throw Error('not loaded');
        return { getDevices: () => prices };
      },
    },
    app: {
      manifest: {
        drivers: [{
          id: 'power',
          settings: [{ children: ['tariff_update_group', 'tariff', 'tariff_export'].map(setting) }],
        }],
      },
    },
  };
  return {
    homey,
    log: () => {},
    error: () => {},
    ds: {
      driverId: 'power',
      setup: {
        settings: ['tariff_update_group', 'tariff', 'tariff_export', 'currency'],
        requirePrice: true,
      },
    },
  };
};

// The pair session: handlers by name.
const pairSession = (driver) => {
  const handlers = {};
  PairSetup.registerPair(driver, {
    setHandler: (name, fn) => {
      handlers[name] = fn;
    },
  }, async () => []);
  handlers.list_devices_selection([{ name: 'Meter', settings: { tariff_update_group: 1 }, store: {} }]);
  return handlers;
};

// A meter with these settings and store, for applyFixedTariff().
const fakeDevice = (settings, store = {}, ids = ['tariff_update_group', 'tariff', 'tariff_export']) => {
  const d = Object.create(GenericDevice.prototype);
  Object.assign(d, {
    settings: { ...settings },
    store: { ...store },
    driver: { ds: { setup: { settings: ids } } },
    homey: {
      __: (key, args = {}) => `${key} ${Object.values(args).join(' ')}`.trim(),
      drivers: { getDriver: () => ({ getDevices: () => [] }) },
    },
    migrated: true,
    timeZone: 'Europe/Amsterdam',
    tariffHistory: { current: 0.3, currentExport: 0.3, currentTm: new Date(0) },
    caps: {},
    log: () => {},
    error: (err) => {
      throw err;
    },
  });
  d.getSettings = () => ({ ...d.settings });
  d.setSettings = async (s) => Object.assign(d.settings, s);
  d.getStoreValue = (k) => (d.store[k] === undefined ? null : d.store[k]);
  d.setStoreValue = async (k, v) => {
    d.store[k] = v;
  };
  d.setCapability = async (cap, v) => {
    d.caps[cap] = v;
  };
  return d;
};

(async () => {
  await test('setup without a price device: fixed tariff chosen, its fields only with group 0', async () => {
    const view = await pairSession(fakeDriver()).setup_get();
    const group = view.settings.find((s) => s.id === 'tariff_update_group');
    assert.deepStrictEqual(group.options, [{ id: 0, label: 'repair.setup_fixed_tariff' }]);
    assert.strictEqual(group.value, 0);
    ['tariff', 'tariff_export', 'currency'].forEach((id) => {
      assert.deepStrictEqual(view.settings.find((s) => s.id === id).showIf, { id: 'tariff_update_group', value: '0' });
    });
    assert.strictEqual(view.settings.find((s) => s.id === 'currency').value, '€');
  });

  await test('setup with a price device: its group first, fixed tariff last', async () => {
    const view = await pairSession(fakeDriver({ 2: 'NL15' })).setup_get();
    const group = view.settings.find((s) => s.id === 'tariff_update_group');
    assert.deepStrictEqual(group.options.map((o) => o.id), [2, 0]);
    assert.strictEqual(group.value, 2);
  });

  await test('pairing a fixed tariff: no price device needed, currency and own export in the store', async () => {
    const { device } = await pairSession(fakeDriver()).setup_set({
      settings: {
        tariff_update_group: '0', tariff: '0.25', tariff_export: '0.08', currency: '€', use_budget: false,
      },
    });
    assert.strictEqual(device.settings.tariff_update_group, 0);
    assert.strictEqual(device.settings.tariff, 0.25);
    assert.strictEqual(device.settings.tariff_export, 0.08);
    assert.deepStrictEqual(device.store.moneyUnit, { currency: '€', decimals: 2 });
    assert.strictEqual(device.store.fixedExport, true);
  });

  await test('pairing an empty tariff group without a price device: refused', async () => {
    await assert.rejects(pairSession(fakeDriver()).setup_set({ settings: { tariff_update_group: '3', tariff: '0.25', use_budget: false } }),
      /error_setup_no_price/);
  });

  await test('device: the fixed tariff and its own export price', async () => {
    const d = fakeDevice({ tariff_update_group: 0, tariff: 0.25, tariff_export: 0.08 }, { fixedExport: true });
    await d.applyFixedTariff();
    assert.strictEqual(d.tariffHistory.current, 0.25);
    assert.strictEqual(d.tariffHistory.currentExport, 0.08);
    assert.strictEqual(d.caps.meter_tariff, 0.25);
  });

  await test('device: an older fixed tariff gets the same export price, once', async () => {
    const d = fakeDevice({ tariff_update_group: 0, tariff: 0.25, tariff_export: 0 });
    await d.applyFixedTariff();
    assert.strictEqual(d.settings.tariff_export, 0.25);
    assert.strictEqual(d.tariffHistory.currentExport, 0.25);
    d.settings.tariff_export = 0.1; // set by the user later
    await d.applyFixedTariff();
    assert.strictEqual(d.tariffHistory.currentExport, 0.1);
  });

  await test('device: gas without an export setting exports at the tariff; a price group is left alone', async () => {
    const gas = fakeDevice({ tariff_update_group: 0, tariff: 1.2 }, {}, ['tariff_update_group', 'tariff']);
    await gas.applyFixedTariff();
    assert.strictEqual(gas.tariffHistory.currentExport, 1.2);
    const fed = fakeDevice({ tariff_update_group: 1, tariff: 0.25 }, { fixedExport: true });
    await fed.applyFixedTariff();
    assert.strictEqual(fed.tariffHistory.current, 0.3);
  });

  await test('flow card: the fixed tariff applies with group 0 only, a price device keeps its price', async () => {
    const fixed = fakeDevice({ tariff_update_group: 0, tariff: 0.25, tariff_export: 0.08 }, { fixedExport: true, moneyUnit: { currency: '€', decimals: 2 } });
    fixed.getName = () => 'Meter';
    await new SumFlows(fixed).set_fixed_tariff({ tariff: 0.27 });
    await new SumFlows(fixed).set_fixed_export_tariff({ tariff: 0.05 });
    assert.strictEqual(fixed.tariffHistory.current, 0.27);
    assert.strictEqual(fixed.tariffHistory.currentExport, 0.05);
    assert.strictEqual(fixed.settings.price_info, 'repair.price_info_fixed_export € 0.27/kWh € 0.05/kWh');
    const fed = fakeDevice({ tariff_update_group: 2, tariff: 0.25 }, { fixedExport: true });
    fed.getName = () => 'Meter';
    await new SumFlows(fed).set_fixed_tariff({ tariff: 0.27 });
    assert.strictEqual(fed.settings.tariff, 0.27); // kept for group 0
    assert.strictEqual(fed.tariffHistory.current, 0.3); // the price device's price stays
    assert.strictEqual(fed.settings.price_info, 'repair.price_info_group_none 2');
  });

  Module._load = origLoad;
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
