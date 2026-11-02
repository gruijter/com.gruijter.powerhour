/* eslint-disable no-console */

'use strict';

// Unit cases for the grid settings in the setup view (lib/helpers/PairSetup.js with the definitions
// of lib/helpers/SetupSettings.json): sections, the advanced toggle and the capacity tariff preset.
// Run: node test/cases/grid_setup.js

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
const GridDriver = require('../../drivers/grid/driver');

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

const PEAK_IDS = ['peakPreset', 'peakLoadIntervalMinutes', 'peakSelection', 'peakCount', 'peakDistinctDays', 'peakHours',
  'peakWeekdaysOnly', 'peakMonths', 'peakWeightOutside', 'peakMinimumW', 'peakPrice', 'peakSteps', 'peakHardLimitW'];
const ADVANCED_IDS = ['tariff_type', 'markup_month', 'markup_day', 'markup_hour', 'connectionVoltage', 'fuseMarginPct', 'decimals_meter'];

// A grid driver at [lat, lon] with a price device in group 1; no grid settings in its manifest.
const fakeDriver = (location = [52.37, 4.9], timeZone = 'Europe/Amsterdam') => {
  const driver = Object.create(GridDriver.prototype);
  const price = { getName: () => 'NL', getSettings: () => ({ tariff_update_group: 1, commodity: 'power' }) };
  Object.assign(driver, {
    homey: {
      __: (key) => key,
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => timeZone },
      geolocation: { getLatitude: () => location[0], getLongitude: () => location[1] },
      drivers: { getDriver: () => ({ getDevices: () => [price] }) },
      app: { manifest: { drivers: [{ id: 'grid', settings: [] }] } },
    },
    log: () => {},
    error: () => {},
    ds: {
      driverId: 'grid',
      deviceCapabilities: [],
      setup: {
        settings: ['tariff_update_group', 'directionalNettingScheme', 'directionalBlockMinutes', 'connectionPhases', 'connectionAmps',
          ...PEAK_IDS, ...ADVANCED_IDS],
        steps: [{ id: 'price', ids: ['tariff_update_group', 'directionalNettingScheme', 'directionalBlockMinutes'] },
          { id: 'connection', ids: ['connectionPhases', 'connectionAmps'] }, { id: 'peak', ids: PEAK_IDS },
          { id: 'year', ids: [] }, { id: 'advanced', ids: ADVANCED_IDS, optional: true }],
        roles: [],
        requirePrice: true,
      },
    },
  });
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

const pairSession = (driver) => {
  const s = session();
  PairSetup.registerPair(driver, s, async () => []);
  s.handlers.list_devices_selection([{ name: 'P1', settings: { tariff_update_group: 1 }, store: {} }]);
  return s.handlers;
};

// A repaired grid device with these settings.
const repairSession = (driver, settings) => {
  const s = session();
  const device = {
    getName: () => 'Grid',
    getSettings: () => ({ tariff_update_group: 1, ...settings }),
    getStoreValue: () => null,
  };
  PairSetup.registerRepair(driver, s, device, async () => [], []);
  return s.handlers;
};

const byId = (view, id) => view.settings.find((s) => s.id === id);
const values = (view, over = {}) => ({
  settings: { ...Object.fromEntries(view.settings.map((s) => [s.id, s.value])), ...over },
});

(async () => {
  await test('pairing: steps, details hidden behind the preset, advanced behind its checkbox', async () => {
    const view = await pairSession(fakeDriver()).setup_get();
    assert.deepStrictEqual(view.steps.map((s) => s.id), ['price', 'connection', 'peak', 'year', 'advanced']);
    assert.strictEqual(view.steps[1].title, 'repair.step_connection');
    assert.strictEqual(byId(view, 'peakPreset').value, 'none');
    assert.strictEqual(byId(view, 'peakPreset').step, 'peak');
    assert.deepStrictEqual(byId(view, 'peakHours').showIf, { id: 'peakPreset', value: 'custom' });
    assert.deepStrictEqual(byId(view, 'directionalBlockMinutes').showIf, { id: 'directionalNettingScheme', value: 'fixedBlock' });
    // The checkbox of the optional step closes the step before; the step shows with it.
    const toggle = byId(view, 'show_advanced');
    assert.strictEqual(toggle.value, false);
    assert.strictEqual(toggle.step, 'year');
    assert.strictEqual(view.settings.map((x) => x.step).lastIndexOf('year'), view.settings.indexOf(toggle));
    assert.deepStrictEqual(view.steps[4].showIf, { id: 'show_advanced', value: true });
    ADVANCED_IDS.forEach((id) => assert.strictEqual(byId(view, id).step, 'advanced', id));
  });

  await test('pairing in Norway: the Norway preset proposed', async () => {
    const view = await pairSession(fakeDriver([59.9, 10.7], 'Europe/Oslo')).setup_get();
    assert.strictEqual(byId(view, 'peakPreset').value, 'norway');
  });

  await test('pairing with a preset: its values on the new device', async () => {
    const handlers = pairSession(fakeDriver());
    const view = await handlers.setup_get();
    const { device } = await handlers.setup_set(values(view, { peakPreset: 'flanders', peakPrice: '4.2' }));
    assert.strictEqual(device.settings.peakPreset, 'flanders');
    assert.strictEqual(device.settings.peakMinimumW, 2500);
    assert.strictEqual(device.settings.peakPrice, 4.2);
    assert.strictEqual(device.settings.connectionVoltage, 230);
    assert.strictEqual(device.settings.decimals_meter, 4);
    assert.strictEqual(device.settings.show_advanced, undefined);
  });

  await test('none clears the price and steps; invalid custom hours refused', async () => {
    const handlers = pairSession(fakeDriver());
    const view = await handlers.setup_get();
    const { device } = await handlers.setup_set(values(view, { peakPreset: 'none', peakPrice: '9', peakSteps: '2:190' }));
    assert.strictEqual(device.settings.peakPrice, 0);
    assert.strictEqual(device.settings.peakSteps, '');
    await assert.rejects(handlers.setup_set(values(view, { peakPreset: 'custom', peakHours: 'x' })), /error_peak_hours/);
  });

  await test('repair: custom without price shows none, advanced open when changed', async () => {
    let view = await repairSession(fakeDriver(), { peakPreset: 'custom', peakPrice: 0, markup_month: 5 }).setup_get();
    assert.strictEqual(byId(view, 'peakPreset').value, 'none');
    assert.strictEqual(byId(view, 'show_advanced').value, true);
    view = await repairSession(fakeDriver(), { peakPreset: 'custom', peakPrice: 3 }).setup_get();
    assert.strictEqual(byId(view, 'peakPreset').value, 'custom');
    assert.strictEqual(byId(view, 'show_advanced').value, false);
  });

  await test('repair start: settings straight to the setup view of the present source', async () => {
    const handlers = repairSession(fakeDriver(), { connectionAmps: 35 });
    const choices = await handlers.start_get();
    assert.deepStrictEqual(choices.map((c) => c.id), ['source', 'price', 'settings', 'budget']);
    assert.strictEqual(await handlers.start_set('settings'), 'setup');
    let view = await handlers.setup_get();
    assert.strictEqual(byId(view, 'connectionAmps').value, 35);
    const shown = (v) => v.steps.filter((st) => !st.hidden).map((st) => st.id);
    assert.ok(!shown(view).includes('price') && !shown(view).includes('year') && shown(view).includes('connection'));
    // Price only: the other steps hidden, their values still in the view.
    await handlers.start_get();
    assert.strictEqual(await handlers.start_set('price'), 'setup');
    view = await handlers.setup_get();
    assert.deepStrictEqual(shown(view), ['price']);
    assert.strictEqual(byId(view, 'connectionAmps').value, 35);
  });

  await test('ev layout: preset only when pairing, departure toggle open with a time', async () => {
    const evDriver = () => {
      const driver = fakeDriver();
      const days = [0, 1, 2, 3, 4, 5, 6].map((day) => `departureTime_${day}`);
      driver.ds = {
        ...driver.ds,
        setup: {
          settings: ['chargePower', 'tariff_update_group', 'chargerControl', ...days],
          steps: [{ id: 'charger', ids: ['chargePower', 'chargerControl'] }, { id: 'ev_price', ids: ['tariff_update_group'] },
            { id: 'departure', ids: days, optional: true }],
          preset: { chargerControl: true },
        },
      };
      return driver;
    };
    let view = await pairSession(evDriver()).setup_get();
    assert.strictEqual(byId(view, 'chargerControl').value, true);
    assert.strictEqual(byId(view, 'show_departure').value, false);
    view = await repairSession(evDriver(), { chargerControl: false, departureTime_2: '07:30' }).setup_get();
    assert.strictEqual(byId(view, 'chargerControl').value, false);
    assert.strictEqual(byId(view, 'show_departure').value, true);
    assert.ok(byId(view, 'chargerControl').info.startsWith('Switches the charger'));
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
