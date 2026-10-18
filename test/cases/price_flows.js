/* eslint-disable no-console */

'use strict';

// Unit cases for lib/flows/PriceFlows.js and lib/helpers/PriceDrivers.js. Run: node test/cases/price_flows.js

const assert = require('assert');
const PriceFlows = require('../../lib/flows/PriceFlows');
const PriceDrivers = require('../../lib/helpers/PriceDrivers');

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

const flowsFor = (state) => {
  const device = { priceInterval: 60, state };
  return new PriceFlows(device);
};

(async () => {
  await test('gas interval is 60, power follows the setting', () => {
    assert.strictEqual(PriceDrivers.intervalOf('price', { commodity: 'gas', priceInterval: '15' }), 60);
    assert.strictEqual(PriceDrivers.intervalOf('price', { commodity: 'power', priceInterval: '15' }), 15);
    assert.strictEqual(PriceDrivers.intervalOf('dap15', {}), 15);
  });

  await test('price vs average with a negative average', async () => {
    const f = flowsFor({ pricesNextHours: [0.05], priceNow: 0.05, avg: -0.05 });
    assert.strictEqual(await f.price_vs_avg({ period: 'avg', direction: 'above', percent: 30 }), true);
    assert.strictEqual(await f.price_vs_avg({ period: 'avg', direction: 'below', percent: 30 }), false);
    const g = flowsFor({ pricesNextHours: [0.1], priceNow: 0.1, avg: 0.2 });
    assert.strictEqual(await g.price_vs_avg({ period: 'avg', direction: 'below', percent: 50 }), true);
    assert.strictEqual(await g.price_vs_avg({ period: 'avg', direction: 'above', percent: 0 }), false);
  });

  await test('trigger fires once when it becomes true', () => {
    const f = flowsFor({});
    const args = { device: {}, number: 2, unit: 'hours' };
    const run = (tm, now, prime) => f.triggerEdge('price_x', args, { pricesStartTm: tm, prime }, now);
    assert.strictEqual(run(1, false, true), false); // primed
    assert.strictEqual(run(2, true), true);
    assert.strictEqual(run(3, true), false, 'still true: no fire');
    assert.strictEqual(run(4, false), false);
    assert.strictEqual(run(5, true), true);
  });

  await test('trigger shares the result between flows with the same args', () => {
    const f = flowsFor({});
    const run = (tm, now) => f.triggerEdge('price_x', { device: {}, n: 1 }, { pricesStartTm: tm }, now);
    run(1, false);
    assert.strictEqual(run(2, true), true);
    assert.strictEqual(run(2, true), true);
  });

  await test('trigger does not fire without a known state before', () => {
    const f = flowsFor({});
    assert.strictEqual(f.triggerEdge('price_x', { device: {} }, { pricesStartTm: 1 }, true), false);
    assert.strictEqual(f.triggerEdge('price_y', { device: {} }, { pricesStartTm: 1, prime: true }, true), false);
    assert.strictEqual(f.triggerEdge('price_y', { device: {} }, { pricesStartTm: 2 }, true), false);
  });

  await test('window between snaps to the slots that overlap it', () => {
    const windowOf = (interval, t1, t2) => {
      const f = new PriceFlows({ priceInterval: interval, state: {} });
      let got;
      f.getPricesInWindow = (a) => {
        got = `${a.time1}-${a.time2}`;
        return { prices: [1], isNowInWindow: true, currentIndex: 0 };
      };
      f.windowBetween(t1, t2);
      return got;
    };
    assert.strictEqual(windowOf(60, '22:30', '06:30'), '22:00-07:00');
    assert.strictEqual(windowOf(60, '22:30', '22:40'), '22:00-23:00');
    assert.strictEqual(windowOf(60, '7:20', '7:10'), '07:00-07:00', 'about 24 hours stays 24 hours');
    assert.strictEqual(windowOf(60, '0:00', '0:00'), '00:00-00:00');
    assert.strictEqual(windowOf(60, '22:00', '23:50'), '22:00-00:00');
    assert.strictEqual(windowOf(15, 7.3, '8:00'), '07:15-08:00');
    assert.strictEqual(windowOf(15, '7:15', '8:00'), '07:15-08:00');
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
