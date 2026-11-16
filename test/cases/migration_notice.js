/* eslint-disable no-console */

'use strict';

// Unit cases for the migration notices (MigrationNotice, FlowScan): the welcome after the update from
// v8, the old cards in flows, and an old tariff card next to a price device of the same group.
// Run: node test/cases/migration_notice.js

const assert = require('assert');
const MigrationNotice = require('../../lib/helpers/MigrationNotice');
const FlowScan = require('../../lib/helpers/FlowScan');
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

const APP = 'homey:app:com.gruijter.powerhour';
const DAY = 24 * 3600 * 1000;

// Flows as the Homey API gives them (card ids verified on Dev 2026-11-15).
const FLOWS = {
  a: {
    name: 'Night tariff',
    enabled: true,
    trigger: { id: 'homey:manager:cron:time' },
    conditions: [],
    actions: [{ id: `${APP}:set_tariff_power`, args: { tariff: 0.1, group: 1 } }],
  },
  b: {
    name: 'Off flow', enabled: false, actions: [{ id: `${APP}:set_tariff_power`, args: { tariff: 0.2, group: 1 } }],
  },
  c: {
    name: 'Other app', enabled: true, actions: [{ id: 'homey:device:other:set_meter_power', args: {} }],
  },
};
const ADVANCED = {
  d: {
    name: 'Meter',
    enabled: true,
    cards: {
      x: { id: 'homey:device:own1:set_meter_power', type: 'action', args: {} },
      w: { id: 'homey:device:own1:retrain_load_model', type: 'action', args: {} }, // no replacement: no notice
      y: { id: 'homey:device:dap1:set_fixed_markup', type: 'action', args: {} },
      z: { type: 'note' },
    },
  },
};

const makeHomey = ({ settings = {}, priceDevices = [] } = {}) => {
  const notes = [];
  const homey = {
    manifest,
    settings: {
      get: (k) => settings[k],
      set: (k, v) => {
        settings[k] = v;
      },
    },
    i18n: { getLanguage: () => 'en' },
    setTimeout: () => 1,
    clearTimeout: () => {},
    on: () => {},
    removeListener: () => {},
    notifications: { createNotification: async ({ excerpt }) => notes.push(excerpt) },
    __: (key, t) => `${key}${t ? `|${Object.keys(t).sort().map((k) => `${k}=${t[k]}`).join('|')}` : ''}`,
    drivers: {
      getDriver: (id) => {
        if (id !== 'price') throw Error('not loaded');
        return { getDevices: () => priceDevices };
      },
    },
  };
  homey.app = {
    api: {
      devices: {
        getDevices: async () => ({
          own1: { id: 'own1', driverId: `${APP}:power` },
          dap1: { id: 'dap1', driverId: `${APP}:dap` },
          other: { id: 'other', driverId: 'homey:app:other.app:meter' },
        }),
      },
      flow: { getFlows: async () => FLOWS, getAdvancedFlows: async () => ADVANCED },
    },
    log: () => {},
    error: () => {},
  };
  return { homey, notes, settings };
};

const priceDevice = (name, group) => {
  const store = {};
  const device = {
    driver: { id: 'price' },
    warning: null,
    getName: () => name,
    getSettings: () => ({ tariff_update_group: group, commodity: 'power' }),
    getData: () => ({ id: name }),
    setWarning: async (w) => {
      device.warning = w;
    },
    setStoreValue: async (k, v) => {
      store[k] = v;
    },
    getStoreValue: (k) => store[k],
    store,
  };
  return device;
};

(async () => {
  await test('FlowScan: own cards of enabled flows only', async () => {
    const { homey } = makeHomey();
    const cards = await FlowScan.appCards(homey);
    assert.deepStrictEqual(cards.map((c) => `${c.flow}:${c.card}`).sort(),
      ['Meter:retrain_load_model', 'Meter:set_fixed_markup', 'Meter:set_meter_power', 'Night tariff:set_tariff_power']);
    assert.deepStrictEqual(FlowScan.tariffFlows(cards, 'power'), { 1: ['Night tariff'] });
    assert.deepStrictEqual(FlowScan.tariffFlows(cards, 'gas'), {});
  });

  await test('FlowScan: deprecated cards without those of the old price drivers', async () => {
    const deprecated = FlowScan.deprecatedCards(manifest);
    assert.ok(deprecated.has('action:set_tariff_power'));
    assert.ok(deprecated.has('action:set_meter_power'));
    assert.ok(!deprecated.has('action:set_fixed_markup'), 'dap card: MigrationNotice lists those flows');
    assert.ok(deprecated.has('action:set_meter'));
    assert.ok(!deprecated.has('action:send_meter'), 'not deprecated');
  });

  await test('noteUpdate: only a level below 9, once', async () => {
    const { homey, settings } = makeHomey();
    MigrationNotice.noteUpdate(homey, '9.0.3');
    MigrationNotice.noteUpdate(homey, '');
    assert.strictEqual(settings.updatedFromV8, undefined);
    MigrationNotice.noteUpdate(homey, '8.21.1');
    const first = settings.updatedFromV8;
    assert.ok(first > 0);
    MigrationNotice.noteUpdate(homey, '8.0.0');
    assert.strictEqual(settings.updatedFromV8, first);
  });

  await test('check: welcome once, old cards a day later, then every 7 days', async () => {
    const now = Date.now();
    const { homey, notes } = makeHomey({ settings: { updatedFromV8: now } });
    const notice = new MigrationNotice(homey);
    await notice.check(now);
    assert.deepStrictEqual(notes, ['migration_welcome']);
    await notice.check(now + 3600 * 1000);
    assert.strictEqual(notes.length, 1, 'no repeat, cards wait a day');
    await notice.check(now + DAY);
    assert.deepStrictEqual(notes.slice(1).sort(), [
      "migration_card_new|card=Send energy reading to virtual meter|flows='Meter'|new=Send reading",
      "migration_card_price|card=Set a new energy tariff|flows='Night tariff'",
    ]);
    await notice.check(now + 2 * DAY);
    assert.strictEqual(notes.length, 3, 'not again within 7 days');
    await notice.check(now + 8 * DAY + 1);
    assert.strictEqual(notes.length, 5);
  });

  await test('check: no old cards left, no more flow scans', async () => {
    const { homey, settings } = makeHomey();
    let scans = 0;
    homey.app.api.flow = {
      getFlows: async () => {
        scans += 1;
        return {};
      },
      getAdvancedFlows: async () => ({}),
    };
    const notice = new MigrationNotice(homey);
    await notice.check(1000);
    const keys = [...FlowScan.deprecatedCards(manifest).keys()].sort().join();
    assert.strictEqual(settings.migrationNoticeLast.cardsDone, keys);
    await notice.check(1000 + 8 * DAY);
    assert.strictEqual(scans, 1);
    // A newly deprecated card: checked again.
    settings.migrationNoticeLast.cardsDone = true;
    await notice.check(1000 + 16 * DAY);
    assert.strictEqual(scans, 2);
  });

  await test('tariffConflict: warning on the price device, notification with the flows, throttled', async () => {
    const price = priceDevice('Electricity price', 1);
    const other = priceDevice('Other group', 2);
    const { homey, notes } = makeHomey({ priceDevices: [price, other] });
    const notice = new MigrationNotice(homey);
    await notice.tariffConflict('power', 1, 1000);
    assert.strictEqual(price.warning, "tariff_flow_warning|flows='Night tariff'");
    assert.strictEqual(price.store[MigrationNotice.FLOW_WARNING_KEY], true);
    assert.strictEqual(other.warning, null);
    assert.deepStrictEqual(notes, ["tariff_flow_conflict|device=Electricity price|flows='Night tariff'"]);
    await notice.tariffConflict('power', 1, 1000 + DAY);
    assert.strictEqual(notes.length, 1, 'within 3 days');
    delete price.store[MigrationNotice.FLOW_WARNING_KEY]; // cleared at a restart
    price.warning = null;
    await notice.tariffConflict('power', 1, 1000 + DAY);
    assert.strictEqual(price.warning, "tariff_flow_warning|flows='Night tariff'", 'set again after a restart');
    await notice.tariffConflict('power', 3, 1000);
    assert.strictEqual(notes.length, 1, 'no price device in group 3');
  });

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(err);
  process.exit(1);
});
