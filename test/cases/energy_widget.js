/* eslint-disable no-console */

'use strict';

// Energy widget: the period meters of grid (import/export/home) and batteries (charged/discharged),
// and getEnergy(), which reads only capabilities.
// Run: node test/cases/energy_widget.js

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

const GridDevice = require('../../drivers/grid/device');
const BatDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const WidgetData = require('../../lib/helpers/WidgetData');

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const run = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

let nextId = 0;
const capDevice = (caps) => ({
  caps,
  id: `dev${nextId++}`, // eslint-disable-line no-plusplus
  getId() {
    return this.id;
  },
  hasCapability: (c) => c in caps,
  getCapabilityValue: (c) => caps[c],
  getSettings: () => ({}),
  getName() {
    return this.id;
  },
});

const makeRig = () => {
  const bat = capDevice({
    meter_kwh_charging: 100, meter_kwh_discharging: 80, 'meter_kwh_this_day.charged': 1, 'meter_kwh_this_day.discharged': 0.5,
  });
  const drivers = {
    battery: [bat], solar: [capDevice({ meter_kwh_this_day: 12.5 })], evCharger: [], gas: [capDevice({ meter_m3_this_day: 3 })],
  };
  const homey = {
    drivers: {
      getDriver: (id) => {
        if (!drivers[id]) throw Error(`no driver ${id}`);
        return { getDevices: () => drivers[id] };
      },
      getDrivers: () => Object.fromEntries(Object.keys(drivers).map((id) => [id, { getDevices: () => drivers[id] }])),
    },
  };
  const grid = Object.create(GridDevice.prototype);
  Object.assign(grid, {
    homey,
    directionalMeter: { importValue: 1000, exportValue: 500 },
    meterPowerHome: 2000,
    marked: [],
    markStoreDirty(key) {
      this.marked.push(key);
    },
    error: (e) => {
      throw e;
    },
    caps: { meter_kwh_this_day: -1.5, meter_money_this_day: 0.75 },
    getCapabilityValue(c) {
      return this.caps[c];
    },
    hasCapability(c) {
      return c in this.caps || /^meter_kwh_(this|last)_(hour|day|month|year)\.(imported|exported|home)$/.test(c);
    },
    async setCapability(c, v) {
      this.caps[c] = v;
    },
    getStoreValue: (k) => (k === 'moneyUnit' ? { currency: 'EUR', decimals: 2 } : null),
    getSettings: () => ({}),
  });
  drivers.grid = [grid];
  return {
    grid, bat, homey, drivers,
  };
};

const none = {
  newHour: false, newDay: false, newMonth: false, newYear: false,
};

test('grid: import, export and home per period from the counters', async () => {
  const { grid, homey } = makeRig();
  await grid.updateSplitMeters(none);
  grid.directionalMeter = { importValue: 1003, exportValue: 504 };
  grid.meterPowerHome = 2007;
  await grid.updateSplitMeters(none);
  assert.deepStrictEqual(['imported', 'exported', 'home'].map((k) => grid.caps[`meter_kwh_this_hour.${k}`]), [3, 4, 7]);
  assert.strictEqual(grid.caps['meter_kwh_this_year.home'], 7);
  await grid.updateSplitMeters({ ...none, newHour: true, newDay: true });
  assert.strictEqual(grid.caps['meter_kwh_last_day.imported'], 3);
  assert.strictEqual(grid.caps['meter_kwh_this_day.imported'], 0);
  const e = WidgetData.getEnergy(homey, 'month');
  assert.deepStrictEqual([e.imported, e.exported, e.home], [3, 4, 7]);
});

test('grid: a period without a home start follows the balance till it ends', async () => {
  const { grid, drivers } = makeRig();
  grid.lastDirectionalReadingMonth = { importValue: 990, exportValue: 500 }; // an older device: no homeValue
  grid.caps.meter_kwh_this_month = 10; // the net meter of the period
  drivers.battery[0].caps['meter_kwh_this_month.charged'] = 0; // not restored yet
  drivers.battery[0].caps['meter_kwh_this_month.discharged'] = 0;
  await grid.updateSplitMeters(none);
  assert.strictEqual(grid.caps['meter_kwh_this_month.home'], 10);
  drivers.battery[0].caps['meter_kwh_this_month.charged'] = 4; // restored later
  await grid.updateSplitMeters(none);
  assert.strictEqual(grid.caps['meter_kwh_this_month.home'], 6);
  grid.caps['meter_kwh_this_month.imported'] = 0; // reset by another device's rollover first
  await grid.updateSplitMeters({ ...none, newMonth: true });
  assert.strictEqual(grid.caps['meter_kwh_last_month.home'], 6); // the start of the tick before
  grid.meterPowerHome = 2002;
  await grid.updateSplitMeters(none);
  assert.strictEqual(grid.caps['meter_kwh_this_month.home'], 2); // the home counter from the new start
});

test('battery: charged and discharged per period; a counter reset keeps the count', async () => {
  const caps = { meter_kwh_charging: 100, meter_kwh_discharging: 80, 'meter_kwh_this_day.charged': 0 };
  const store = {};
  const bat = Object.assign(Object.create(BatDevice.prototype), {
    homey: {},
    hasCapability: (c) => c in caps || /^meter_kwh_(this|last)_(hour|day|month|year)\.(dis)?charged$/.test(c),
    getCapabilityValue: (c) => caps[c],
    setCapability: async (c, v) => {
      caps[c] = v;
    },
    getStoreValue: (k) => store[k],
    setStoreValue: async (k, v) => {
      store[k] = v;
    },
    error: (e) => {
      throw e;
    },
    counterRestore: Promise.resolve(), // no Insights here
  });
  await bat.updateCounterPeriods(none);
  caps.meter_kwh_charging = 105;
  await bat.updateCounterPeriods(none);
  assert.strictEqual(caps['meter_kwh_this_month.charged'], 5);
  caps.meter_kwh_charging = 3; // the source counter restarted
  await bat.updateCounterPeriods(none);
  caps.meter_kwh_charging = 4;
  await bat.updateCounterPeriods(none);
  assert.strictEqual(caps['meter_kwh_this_month.charged'], 6);
  await bat.updateCounterPeriods({ ...none, newDay: true });
  assert.strictEqual(caps['meter_kwh_last_day.charged'], 6);
  assert.strictEqual(caps['meter_kwh_this_day.charged'], 0);
  assert.ok(store.counterReadings.day);
});

test('widget: batteries and V2X cars from their period meters', () => {
  const { homey, drivers } = makeRig();
  drivers.battery = [capDevice({ 'meter_kwh_this_day.charged': 2, 'meter_kwh_this_day.discharged': 1.5 })];
  const car = capDevice({
    'meter_kwh_this_day.charged': 6, 'meter_kwh_this_day.discharged': 5, meter_kwh_this_day: 1, measure_ev_soc: 64, ev_car_state: 'away',
  });
  const plain = capDevice({ meter_kwh_this_day: 2 });
  drivers.evCharger.push(car, plain);
  const e = WidgetData.getEnergy(homey, 'day');
  assert.deepStrictEqual([e.charged, e.discharged], [2, 1.5]);
  const [a, b] = e.evs;
  assert.deepStrictEqual([a.name, a.soc, a.state, a.charged, a.discharged, a.kwh], [car.id, 64, 'away', 6, 5, 1]);
  assert.deepStrictEqual([b.soc, b.state, b.charged, b.discharged, b.kwh], [null, null, null, null, 2]);
});

test('gas and water: the meter on the smart meter only, else all', () => {
  const { grid, homey, drivers } = makeRig();
  const sub = capDevice({ meter_m3_this_day: 1 });
  sub.getSettings = () => ({ homey_device_id: 'boiler' });
  drivers.gas.push(sub);
  drivers.water = [capDevice({ meter_m3_this_day: 0.2 })];
  assert.strictEqual(WidgetData.getEnergy(homey, 'day').gasM3, 4); // no source on the grid: all
  grid.getSettings = () => ({ homey_device_id: 'p1' });
  drivers.gas[0].getSettings = () => ({ homey_device_id: 'p1' });
  assert.strictEqual(WidgetData.getEnergy(homey, 'day').gasM3, 3);
  assert.strictEqual(WidgetData.getEnergy(homey, 'day').waterM3, 0.2); // none on p1: all
});

test('flows: climate summarizers apart, chosen users in the chosen order, none chosen: all but Homey Energy fed', () => {
  const { homey, drivers } = makeRig();
  const pump = capDevice({ meter_kwh_this_day: 4 });
  pump.getSettings = () => ({ climate: true });
  const tv = capDevice({ meter_kwh_this_day: 1 });
  const oven = capDevice({ meter_kwh_this_day: 2 });
  drivers.power = [pump, tv, oven];
  const solarTotal = capDevice({ meter_kwh_this_day: 40 });
  solarTotal.getSettings = () => ({ homey_energy: 'totalGenerated' });
  drivers.power.push(solarTotal);
  const all = WidgetData.getFlows(homey, 'day', []);
  assert.deepStrictEqual(all.climate.map((c) => c.value), [4]);
  assert.deepStrictEqual(all.users.map((u) => u.name), [tv.id, oven.id]); // not the Homey Energy solar total
  const order = WidgetData.getFlows(homey, 'day', [oven.id, pump.id, tv.id]);
  assert.deepStrictEqual(order.users.map((u) => u.name), [oven.id, tv.id]); // the climate pump not as user
  assert.deepStrictEqual(order.sources.map((x) => x.key), ['grid', 'solar', 'battery']);
  assert.strictEqual(order.gas, 3);
  assert.strictEqual(order.live, false);
});

test('flows: a summarizer on the solar source is no user', () => {
  const { homey, drivers } = makeRig();
  const pv = capDevice({ meter_kwh_this_day: 3 });
  pv.getSettings = () => ({ homey_device_id: 'plug' });
  const tv = capDevice({ meter_kwh_this_day: 1 });
  drivers.power = [pv, tv];
  const sun = capDevice({ meter_kwh_this_day: 3 });
  sun.getSettings = () => ({ homey_device_id: 'plug' });
  drivers.solar = [sun];
  assert.deepStrictEqual(WidgetData.getFlows(homey, 'day', []).users.map((u) => u.name), [tv.id]);
});

test('money: grid meter and unit, no meter gives null', () => {
  const { homey } = makeRig();
  const { money } = WidgetData.getEnergy(homey, 'day');
  assert.strictEqual(money.grid, 0.75);
  assert.strictEqual(money.currency, 'EUR');
  assert.strictEqual(money.solar, null);
  assert.strictEqual(money.ev, null);
});

test('money: solar value negative, like the battery profit', () => {
  const { homey, drivers } = makeRig();
  drivers.solar = [capDevice({ meter_kwh_this_day: 5, meter_money_this_day: 1.2 })];
  const { money } = WidgetData.getEnergy(homey, 'day');
  assert.strictEqual(money.solar, -1.2);
});

(async () => {
  for (const [name, fn] of tests) await run(name, fn);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
