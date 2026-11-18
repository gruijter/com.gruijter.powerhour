/* eslint-disable no-console */

'use strict';

// Unit cases: battery and EV plan with the price profile of the Energy Price device of their tariff
// group; without one (prices by flow) with their own, learned from what they receive.
// Run: node test/cases/price_profile_source.js

const assert = require('assert');
const FileStore = require('../../lib/helpers/FileStore');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const PriceProfile = require('../../lib/strategies/PriceProfile');

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

const store = new Map();
FileStore.open = async () => ({ get: (k) => store.get(k), set: (k, v) => store.set(k, v) });

const charger = (priceDevices) => Object.assign(Object.create(ChargeDeviceHelpers), {
  _groupPriceDevices: () => priceDevices,
  log: () => {},
});
const H = 3600000;
const fromNow = { prices: [0.2, 0.3, 0.4], isForecast: [false, false, true] };
const start = Date.UTC(2026, 10, 18, 12);

(async () => {
  await test('with an Energy Price device: its profile, the own one not learned', async () => {
    const shared = PriceProfile.createProfile();
    const dev = charger([{ driver: { id: 'price' }, priceProfile: shared }]);
    const known = await dev.learnPriceProfile(fromNow, start, 60, 'UTC');
    assert.strictEqual(known.length, 2);
    assert.strictEqual(dev.priceProfile, shared);
    assert.strictEqual(dev.ownPriceProfile.lastLearnedMs, 0);
  });

  await test('without (prices by flow): the own profile, learned', async () => {
    const dev = charger([]);
    await dev.learnPriceProfile(fromNow, start, 60, 'UTC');
    assert.strictEqual(dev.priceProfile, dev.ownPriceProfile);
    assert.strictEqual(dev.ownPriceProfile.lastLearnedMs, start + H);
  });

  await test('an old price driver (dap) has no shared profile: own one', async () => {
    const dev = charger([{ driver: { id: 'dap' } }]);
    await dev.learnPriceProfile(fromNow, start, 60, 'UTC');
    assert.strictEqual(dev.priceProfile, dev.ownPriceProfile);
  });

  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
