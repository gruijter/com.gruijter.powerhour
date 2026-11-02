/* eslint-disable no-console */

'use strict';

// Unit cases for the battery, EV charger and solar settings in the setup view (lib/helpers/PairSetup.js
// with lib/helpers/DriverSetupSettings.json), and the advanced fields of the price setup.
// Run: node test/cases/driver_setup.js

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
const PairSetup = require('../../lib/helpers/PairSetup');
const DriverSetupSettings = require('../../lib/helpers/DriverSetupSettings.json');
const BatteryDriver = require('../../drivers/battery/driver');
const EvDriver = require('../../drivers/evCharger/driver');
const SolarDriver = require('../../drivers/solar/driver');
const PriceDriver = require('../../drivers/price/driver');
const PriceSetup = require('../../lib/helpers/PriceSetup');
const manifest = require('../../app.json');

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

// The driver with its real ds (onInit without the base class and polling).
const fakeDriver = async (Driver, { devices = [], evChargers = 0 } = {}) => {
  const driver = Object.create(Driver.prototype);
  const price = { getName: () => 'NL', getSettings: () => ({ tariff_update_group: 1, commodity: 'power' }) };
  Object.assign(driver, {
    homey: {
      __: (key) => key,
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => 'Europe/Amsterdam' },
      geolocation: { getLatitude: () => 52.37, getLongitude: () => 4.9 },
      drivers: {
        getDriver: (id) => ({ getDevices: () => (id === 'evCharger' ? new Array(evChargers).fill({}) : [price]) }),
      },
      app: { manifest },
    },
    log: () => {},
    error: () => {},
    getDevices: () => devices,
    setupRoles: async () => null,
  });
  const base = Object.getPrototypeOf(Driver.prototype);
  const { onInit } = base;
  base.onInit = async () => {};
  await Driver.prototype.onInit.call(driver);
  base.onInit = onInit;
  return driver;
};

const session = () => {
  const handlers = {};
  return {
    handlers,
    setHandler: (name, fn) => {
      handlers[name] = fn;
    },
  };
};

const pairView = async (driver, settings = {}) => {
  const s = session();
  PairSetup.registerPair(driver, s, async () => []);
  s.handlers.list_devices_selection([{
    name: 'Src', settings: { tariff_update_group: 1, homey_device_id: 'src', ...settings }, store: {},
  }]);
  return { view: await s.handlers.setup_get(), handlers: s.handlers };
};

const byId = (view, id) => view.settings.find((s) => s.id === id);
const values = (view, over = {}) => ({
  settings: { ...Object.fromEntries(view.settings.map((s) => [s.id, s.value])), ...over },
});

// Every setting moved out of a manifest: no longer there, defined for the setup view.
const manifestIds = (driverId) => {
  const ids = [];
  const walk = (list) => (list || []).forEach((s) => (s.children ? walk(s.children) : ids.push(s.id)));
  walk(manifest.drivers.find((d) => d.id === driverId).settings);
  return ids;
};

(async () => {
  await test('moved settings are out of the manifest, with all 13 languages', async () => {
    const langs = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'pl', 'ru', 'ar', 'ko'];
    Object.entries(DriverSetupSettings).forEach(([driverId, defs]) => {
      const left = manifestIds(driverId);
      Object.entries(defs).forEach(([id, def]) => {
        assert.ok(!left.includes(id), `${driverId}.${id} still in the manifest`);
        ['label', 'info'].filter((key) => def[key]).forEach((key) => {
          langs.forEach((lang) => assert.ok(def[key][lang] !== undefined, `${driverId}.${id}.${key}.${lang}`));
        });
      });
    });
  });

  await test('battery: steps, calibration only with control', async () => {
    const { view } = await pairView(await fakeDriver(BatteryDriver));
    assert.deepStrictEqual(view.steps.map((s) => s.id), ['battery', 'wear', 'price', 'plan', 'grid_limits', 'control', 'chart']);
    assert.strictEqual(byId(view, 'roiMinProfit').step, 'wear');
    assert.strictEqual(byId(view, 'tariff_type').step, 'price');
    assert.strictEqual(byId(view, 'wearCalc').step, 'wear');
    assert.strictEqual(byId(view, 'chargePower').step, 'battery');
    assert.strictEqual(byId(view, 'show_chart'), undefined);
    assert.strictEqual(byId(view, 'batCapacity').value, 5.05);
    assert.ok(byId(view, 'roiWearCost').info.startsWith('What a kWh'));
    assert.deepStrictEqual(byId(view, 'calibrateDays').showIf, { id: 'batteryControl', value: true });
    assert.strictEqual(byId(view, 'chartShowSoc').step, 'chart');
  });

  await test('battery: EV and group settings only when they apply', async () => {
    let { view } = await pairView(await fakeDriver(BatteryDriver));
    assert.strictEqual(byId(view, 'dischargeToEv'), undefined);
    assert.strictEqual(byId(view, 'groupPlan'), undefined);
    const other = { getSettings: () => ({ homey_device_id: 'other' }) };
    ({ view } = await pairView(await fakeDriver(BatteryDriver, { devices: [other], evChargers: 1 })));
    assert.strictEqual(byId(view, 'dischargeToEv').value, true);
    assert.strictEqual(byId(view, 'groupPlan').value, true);
    // Repairing the only battery (same source): no group.
    const self = { getSettings: () => ({ homey_device_id: 'src' }) };
    ({ view } = await pairView(await fakeDriver(BatteryDriver, { devices: [self] })));
    assert.strictEqual(byId(view, 'groupPlan'), undefined);
  });

  await test('battery: values are parsed into the new device', async () => {
    const driver = await fakeDriver(BatteryDriver);
    const { view, handlers } = await pairView(driver);
    const { device } = await handlers.setup_set(values(view, { batteryControl: true, calibrateDays: '3', peakReservePct: '150' }));
    assert.strictEqual(device.settings.calibrateDays, 3);
    assert.strictEqual(device.settings.peakReservePct, 90);
    assert.strictEqual(device.settings.batteryControl, true);
  });

  await test('battery: wear helper fills in the wear cost, which stays editable', async () => {
    const driver = await fakeDriver(BatteryDriver);
    const { view, handlers } = await pairView(driver);
    assert.strictEqual(byId(view, 'roiWearCost').showIf, undefined);
    assert.deepStrictEqual(byId(view, 'wearCycles').showIf, { id: 'wearCalc', value: true });
    assert.deepStrictEqual(view.calc, ['wearCalc', 'batCapacity', 'wearPurchasePrice', 'wearCycles']);
    // 3000 / (5 kWh x 6000 cycles x 0.85 average capacity)
    const settings = {
      wearCalc: true, batCapacity: '5', wearPurchasePrice: '3000', wearCycles: '6000',
    };
    assert.deepStrictEqual(await handlers.setup_calc({ settings }), { roiWearCost: 0.1176 });
    assert.deepStrictEqual(await handlers.setup_calc({ settings: { ...settings, wearCalc: false } }), {});
    assert.deepStrictEqual(await handlers.setup_calc({ settings: { ...settings, wearPurchasePrice: '' } }), {});
    // An edited wear cost is kept.
    const { device } = await handlers.setup_set(values(view, { ...settings, roiWearCost: '0.09' }));
    assert.strictEqual(device.settings.roiWearCost, 0.09);
    assert.strictEqual(device.settings.wearPurchasePrice, 3000);
  });

  await test('ev charger: charge levels, fixed price only with "fixed", order checked', async () => {
    const driver = await fakeDriver(EvDriver);
    const { view, handlers } = await pairView(driver);
    assert.ok(view.steps.some((s) => s.id === 'levels'));
    assert.strictEqual(byId(view, 'floorSoc').step, 'levels');
    assert.deepStrictEqual(byId(view, 'cheapPrice').showIf, { id: 'cheapCharge', value: 'fixed' });
    await assert.rejects(handlers.setup_set(values(view, { floorSoc: '40', reserveSoc: '30' })), /error_setup_soc_order/);
    await assert.rejects(handlers.setup_set(values(view, { maxSoc: '25' })), /error_setup_soc_order/);
    const { device } = await handlers.setup_set(values(view, { floorSoc: '10', reserveSoc: '30', maxSoc: '90' }));
    assert.strictEqual(device.settings.maxSoc, 90);
  });

  await test('solar: location in the advanced step', async () => {
    const { view } = await pairView(await fakeDriver(SolarDriver), { source_device_type: 'Homey device' });
    assert.strictEqual(byId(view, 'lat').step, 'advanced');
    assert.strictEqual(byId(view, 'peakPower').value, 0);
  });

  await test('price: advanced fields with their defaults and hints, a bad formula refused', async () => {
    const driver = Object.create(PriceDriver.prototype);
    Object.assign(driver, {
      homey: {
        __: (key) => key,
        i18n: { getLanguage: () => 'en' },
        clock: { getTimezone: () => 'Europe/Amsterdam' },
        geolocation: { getLatitude: () => 52.37, getLongitude: () => 4.9 },
        drivers: { getDriver: () => ({ getDevices: () => [] }) },
        app: { manifest },
      },
      log: () => {},
      error: () => {},
      ds: { driverId: 'price' },
    });
    const s = session();
    PriceSetup.registerPair(driver, s);
    const data = await s.handlers.setup_get();
    assert.deepStrictEqual(data.advanced, ['priceProvider', 'entsoeApiKey', 'forecastEnable', 'variableMarkupAbsPrice',
      'export_variableMarkupAbsPrice', 'formula', 'export_formula', 'decimals']);
    assert.strictEqual(data.defs.decimals.value, 4);
    assert.strictEqual(data.defs.priceProvider.value, 'AUTO');
    assert.ok(data.defs.fixedMarkup.hint.startsWith('Per kWh'));
    assert.ok(data.defs.exchangeRate && data.defs.export_show_chart_line);
    const form = {
      ...data.values, biddingZone: data.values.powerZone, decimals: '3', exchangeRate: '11.5', priceProvider: 'ENTSOE',
    };
    const { device } = await s.handlers.setup_set(form);
    assert.strictEqual(device.settings.decimals, 3);
    assert.strictEqual(device.settings.exchangeRate, 11.5);
    assert.strictEqual(device.settings.priceProvider, 'ENTSOE');
    await assert.rejects(s.handlers.setup_set({ ...form, formula: 'market +* 2' }), /error_formula_/);
  });

  await test('battery repair: device values only when the source changes, control needs a setpoint', async () => {
    const driver = await fakeDriver(BatteryDriver);
    driver.setupRoles = async () => ({ deviceId: 'src', items: [{ key: 'setpoint', auto: 'target_power', options: [] }] });
    const device = {
      getName: () => 'Bat', getSettings: () => ({ tariff_update_group: 1, homey_device_id: 'src' }), getStoreValue: () => null,
    };
    const repair = () => {
      const s = session();
      PairSetup.registerRepair(driver, s, device, async () => [], []);
      return s.handlers;
    };
    // Settings only (no list): the device values step stays hidden, Previous goes to the choices.
    let h = repair();
    let view = await h.setup_get();
    assert.strictEqual(view.steps[0].id, 'device');
    assert.strictEqual(view.steps[0].hidden, true);
    assert.strictEqual(view.back, 'repair_start');
    assert.deepStrictEqual(byId(view, 'batteryControl').showIf, { role: 'setpoint' });
    assert.strictEqual(byId(view, 'learnReset').step, 'battery');
    // Another source from the list: the device values first.
    h = repair();
    h.list_devices_selection([{ name: 'Src', settings: { tariff_update_group: 1, homey_device_id: 'src' } }]);
    view = await h.setup_get();
    assert.strictEqual(view.steps[0].hidden, undefined);
    assert.strictEqual(view.back, 'list_devices');
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  // The drivers' polling helpers keep a retry timer: do not wait for it.
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
