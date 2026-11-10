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
const BatteryDevice = require('../../drivers/battery/device');
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
const fakeDriver = async (Driver, { devices = [], evChargers = 0, grid = null } = {}) => {
  const driver = Object.create(Driver.prototype);
  const price = { getName: () => 'NL', getSettings: () => ({ tariff_update_group: 1, commodity: 'power' }) };
  Object.assign(driver, {
    homey: {
      __: (key) => key,
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => 'Europe/Amsterdam' },
      geolocation: { getLatitude: () => 52.37, getLongitude: () => 4.9 },
      drivers: {
        getDriver: (id) => {
          if (id === 'grid' && grid) return { getDevices: () => [grid] };
          return { getDevices: () => (id === 'evCharger' ? new Array(evChargers).fill({}) : [price]) };
        },
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
    assert.deepStrictEqual(view.steps.map((s) => s.id), ['battery', 'control', 'wear', 'price', 'grid_limits', 'advanced']);
    // Pairing asks the battery, its control and the price: the other steps hidden, their defaults sent back.
    assert.deepStrictEqual(view.steps.filter((s) => s.hidden).map((s) => s.id), ['wear', 'grid_limits', 'advanced']);
    assert.strictEqual(byId(view, 'fuseProtection').value, true);
    assert.strictEqual(byId(view, 'peakShaving').value, false);
    assert.strictEqual(byId(view, 'minProfit').step, 'wear');
    assert.strictEqual(byId(view, 'tariff_type').step, 'advanced');
    assert.strictEqual(byId(view, 'wearCalc').step, 'wear');
    assert.strictEqual(byId(view, 'chargePower').step, 'battery');
    assert.strictEqual(byId(view, 'show_chart'), undefined);
    assert.strictEqual(byId(view, 'batCapacity').value, 5.05);
    assert.ok(byId(view, 'wearCost').info.startsWith('What a kWh'));
    assert.deepStrictEqual(byId(view, 'calibrateDays').showIf, { id: 'batteryControl', value: true });
    assert.strictEqual(byId(view, 'chartShowSoc').step, 'advanced');
  });

  await test('battery: with a capacity tariff pairing asks the grid limits, peaks limited', async () => {
    const grid = { getImportHeadroomW: () => null, peakConfig: { pricePerKw: 5, steps: [], preset: 'custom' } };
    const { view, handlers } = await pairView(await fakeDriver(BatteryDriver, { grid }));
    assert.strictEqual(view.steps.find((s) => s.id === 'grid_limits').hidden, undefined);
    assert.strictEqual(byId(view, 'peakShaving').value, true);
    assert.strictEqual(byId(view, 'peakReservePct').value, 10);
    const { device } = await handlers.setup_set(values(view));
    assert.strictEqual(device.settings.peakShaving, true);
    assert.strictEqual(device.settings.peakReservePct, 10);
    // No tariff set on the grid device: as without one.
    const none = { getImportHeadroomW: () => null, peakConfig: { pricePerKw: 0, steps: [], preset: 'custom' } };
    const plain = (await pairView(await fakeDriver(BatteryDriver, { grid: none }))).view;
    assert.strictEqual(plain.steps.find((s) => s.id === 'grid_limits').hidden, true);
    assert.strictEqual(byId(plain, 'peakShaving').value, false);
  });

  await test('battery: the minimum profit of a new battery is a share of the mean price', async () => {
    const driver = await fakeDriver(BatteryDriver);
    driver.pricesNextHours = { 1: [0.2, 0.3, 0.25], 2: [1.4, 1.8] };
    let { view, handlers } = await pairView(driver);
    let { device } = await handlers.setup_set(values(view));
    assert.strictEqual(device.settings.minProfit, 0.025);
    assert.strictEqual(device.settings.minProfitAuto, undefined);
    assert.strictEqual(driver.defaultMinProfit(2), 0.16); // another currency
    // No prices yet: from the first ones.
    driver.pricesNextHours = {};
    ({ view, handlers } = await pairView(driver));
    ({ device } = await handlers.setup_set(values(view)));
    assert.strictEqual(device.settings.minProfit, 0);
    assert.strictEqual(device.settings.minProfitAuto, true);
    const set = [];
    const bat = Object.assign(Object.create(BatteryDevice.prototype), {
      driver,
      getSettings: () => ({ ...device.settings, ...Object.assign({}, ...set) }),
      setSettings: async (v) => set.push(v),
      getName: () => 'Bat',
      log: () => {},
    });
    await bat.applyAutoMinProfit();
    assert.deepStrictEqual(set, []);
    driver.pricesNextHours = { 1: [0.2, 0.3, 0.25] };
    await bat.applyAutoMinProfit();
    await bat.applyAutoMinProfit();
    assert.deepStrictEqual(set, [{ minProfit: 0.025, minProfitAuto: false }]);
  });

  await test('battery: a standard battery is only asked its setpoint when pairing', async () => {
    const cap = (units, extra = {}) => ({
      value: 0, units, type: 'number', title: 'x', ...extra,
    });
    const source = {
      id: 'src',
      name: 'Bat',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power', 'target_power'],
      capabilitiesObj: { measure_battery: cap('%'), measure_power: cap('W'), target_power: cap('W', { setable: true }) },
    };
    const withSource = async (src) => {
      const driver = await fakeDriver(BatteryDriver);
      delete driver.setupRoles;
      driver._setupSourceDevice = async () => src;
      return driver;
    };
    let { view } = await pairView(await withSource(source));
    assert.deepStrictEqual(view.roles.items.map((r) => r.key), ['setpoint', 'setpointSign']);
    // No mode capability: the battery's own app is set to external control by hand.
    assert.ok(byId(view, 'batteryControl').info.endsWith('repair.setup_bat_external'));
    // Not Homey's standard (a vendor's capabilities): all roles asked.
    const vendor = {
      ...source,
      class: 'other',
      capabilities: ['measure_battery', 'measure_power.battery'],
      capabilitiesObj: { measure_battery: cap('%'), 'measure_power.battery': cap('W') },
    };
    ({ view } = await pairView(await withSource(vendor)));
    assert.ok(view.roles.items.some((r) => r.key === 'soc') && view.roles.items.some((r) => r.key === 'sign'));
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
    assert.strictEqual(byId(view, 'wearCost').showIf, undefined);
    assert.deepStrictEqual(byId(view, 'wearCycles').showIf, { id: 'wearCalc', value: true });
    assert.deepStrictEqual(view.calc, ['wearCalc', 'batCapacity', 'wearPurchasePrice', 'wearCycles']);
    // 3000 / (5 kWh x 6000 cycles x 0.85 average capacity)
    const settings = {
      wearCalc: true, batCapacity: '5', wearPurchasePrice: '3000', wearCycles: '6000',
    };
    assert.deepStrictEqual(await handlers.setup_calc({ settings }), { wearCost: 0.1176 });
    assert.deepStrictEqual(await handlers.setup_calc({ settings: { ...settings, wearCalc: false } }), {});
    assert.deepStrictEqual(await handlers.setup_calc({ settings: { ...settings, wearPurchasePrice: '' } }), {});
    // An edited wear cost is kept.
    const { device } = await handlers.setup_set(values(view, { ...settings, wearCost: '0.09' }));
    assert.strictEqual(device.settings.wearCost, 0.09);
    assert.strictEqual(device.settings.wearPurchasePrice, 3000);
  });

  await test('ev charger: charge levels, fixed price only with "fixed", order checked', async () => {
    const driver = await fakeDriver(EvDriver);
    const { view, handlers } = await pairView(driver);
    assert.ok(!view.steps.some((s) => s.id === 'levels'));
    assert.strictEqual(byId(view, 'floorSoc').step, 'car');
    // Departure and year optional: both checkboxes at the end of the price step.
    const toggles = view.settings.filter((s) => s.id.startsWith('show_')).map((s) => [s.id, s.step]);
    assert.deepStrictEqual(toggles, [['show_departure', 'ev_price'], ['show_year', 'ev_price']]);
    assert.deepStrictEqual(byId(view, 'cheapPrice').showIf, { id: 'cheapCharge', value: 'fixed' });
    await assert.rejects(handlers.setup_set(values(view, { floorSoc: '40', reserveSoc: '30' })), /error_setup_soc_order/);
    await assert.rejects(handlers.setup_set(values(view, { maxSoc: '25' })), /error_setup_soc_order/);
    const { device } = await handlers.setup_set(values(view, { floorSoc: '10', reserveSoc: '30', maxSoc: '90' }));
    assert.strictEqual(device.settings.maxSoc, 90);
  });

  await test('year optional when pairing: on with a preset budget, off means no budget', async () => {
    const { view, handlers } = await pairView(await fakeDriver(SolarDriver), { source_device_type: 'Homey device' });
    const toggle = byId(view, 'show_year');
    assert.strictEqual(toggle.value, true);
    assert.deepStrictEqual(view.steps.find((s) => s.id === 'year').showIf, { id: 'show_year', value: true });
    const { device } = await handlers.setup_set(values(view, { show_year: false }));
    assert.strictEqual(device.settings.budget, '0');
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
    // Only the device values: the settings stay as they are, hidden in the view.
    assert.ok(view.steps.filter((st) => !st.hidden).every((st) => st.roles), 'only the roles steps');
    assert.strictEqual(view.steps.find((st) => st.id === 'battery').hidden, true);
    assert.strictEqual(byId(view, 'batCapacity').value, 5.05);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  // The drivers' polling helpers keep a retry timer: do not wait for it.
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
