/* eslint-disable no-console */

'use strict';

// Tariff group conflict: two price devices sending to one group notify, also with the same interval.
// Run: node test/cases/price_group_conflict.js

const assert = require('assert');
const PriceIntervalGroups = require('../../lib/helpers/PriceIntervalGroups');

const device = (id, group, driverId = 'price') => ({
  isDeleted: false,
  driver: { id: driverId },
  getData: () => ({ id }),
  getSettings: () => ({ tariff_update_group: group, commodity: 'power' }),
});

const homeyWith = (devices) => {
  const sent = [];
  return {
    sent,
    __: (key, args) => `${key} ${JSON.stringify(args)}`,
    notifications: {
      createNotification: async ({ excerpt }) => {
        sent.push(excerpt);
      },
    },
    drivers: {
      getDriver: (id) => ({ getDevices: () => devices.filter((d) => d.driver.id === id) }),
    },
    app: { error: () => {} },
  };
};

const CH = 'set_tariff_power_PBTH';
const vote = (g, sourceId, interval, now) => g.apply({
  channel: CH, group: 1, sourceId, sourceName: sourceId, interval, now,
});

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.stack}`);
  }
};

(async () => {
  await test('one device: no notification', async () => {
    const homey = homeyWith([device('a', 1)]);
    const g = new PriceIntervalGroups(homey);
    assert.strictEqual(await vote(g, 'a', 15, 0), 15);
    assert.strictEqual(homey.sent.length, 0);
  });

  await test('two devices, same interval: one notification, again after a day', async () => {
    const homey = homeyWith([device('a', 1), device('b', 1)]);
    const g = new PriceIntervalGroups(homey);
    await vote(g, 'a', 15, 0);
    await vote(g, 'b', 15, 1000);
    await vote(g, 'a', 15, 2000);
    await vote(g, 'b', 15, 15 * 60000);
    assert.strictEqual(homey.sent.length, 1);
    assert.ok(homey.sent[0].startsWith('tariff_group_conflict'));
    assert.ok(homey.sent[0].includes('a, b'));
    await vote(g, 'b', 15, 25 * 3600000);
    await vote(g, 'a', 15, 25 * 3600000 + 1000);
    assert.strictEqual(homey.sent.length, 2);
  });

  await test('different intervals: finest wins and notifies', async () => {
    const homey = homeyWith([device('a', 1), device('b', 1, 'dap')]);
    const g = new PriceIntervalGroups(homey);
    await vote(g, 'b', 60, 0);
    assert.strictEqual(await vote(g, 'a', 15, 1000), 15);
    assert.strictEqual(homey.sent.length, 1);
  });

  await test('a device moved to another group stops voting at once', async () => {
    const b = device('b', 1);
    const homey = homeyWith([device('a', 1), b]);
    const g = new PriceIntervalGroups(homey);
    await vote(g, 'a', 15, 0);
    await vote(g, 'b', 60, 1000);
    assert.strictEqual(homey.sent.length, 1);
    b.getSettings = () => ({ tariff_update_group: 2, commodity: 'power' });
    assert.strictEqual(g.resolve({ channel: CH, group: 1, now: 2000 }).conflict, false);
    assert.strictEqual(await vote(g, 'a', 60, 3000), 60);
  });

  await test('groupConflict: warning text per group and commodity', async () => {
    const PriceDrivers = require('../../lib/helpers/PriceDrivers');
    const named = (id, group, commodity = 'power') => ({
      ...device(id, group), getName: () => id, getSettings: () => ({ tariff_update_group: group, commodity }),
    });
    const homey = homeyWith([named('a', 1), named('b', 1), named('c', 2), named('g', 2, 'gas')]);
    assert.strictEqual(PriceDrivers.groupConflict(homey, 'power', 1), 'tariff_group_conflict {"group":"1","sources":"a, b"}');
    assert.strictEqual(PriceDrivers.groupConflict(homey, 'power', 2), null);
    assert.strictEqual(PriceDrivers.groupConflict(homey, 'gas', 2), null);
    assert.strictEqual(PriceDrivers.groupConflict(homey, 'power', 0), null);
  });

  await test('no price device: warned, unless a tariff flow feeds the group', async () => {
    const PriceDrivers = require('../../lib/helpers/PriceDrivers');
    const homey = homeyWith([]);
    assert.strictEqual(PriceDrivers.priceWarning(homey, 'gas', 1).split(' ')[0], 'warning_no_price_device');
    PriceDrivers.tariffScanState(homey).result = { power: {}, gas: { 1: ['Gas price'] }, water: {} };
    assert.strictEqual(PriceDrivers.priceWarning(homey, 'gas', 1), null);
    assert.strictEqual(PriceDrivers.priceWarning(homey, 'gas', 2).split(' ')[0], 'warning_no_price_device');
    PriceDrivers.flowTariffRan(homey, 'water', 3, null);
    assert.strictEqual(PriceDrivers.priceWarning(homey, 'water', 3), null);
    assert.strictEqual(PriceDrivers.priceWarning(homey, 'water', 0), null);
  });

  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
