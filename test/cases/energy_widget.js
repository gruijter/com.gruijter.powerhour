/* eslint-disable no-console */

'use strict';

// Energy widget: grid period baselines (updateEnergyBaselines/getEnergySince) and getEnergy().
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
const WidgetData = require('../../lib/helpers/WidgetData');

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
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
  const bat = capDevice({ meter_kwh_charging: 100, meter_kwh_discharging: 80 });
  const drivers = {
    battery: [bat], solar: [capDevice({ meter_kwh_this_day: 12.5 })], evCharger: [], gas: [capDevice({ meter_m3_this_day: 3 })],
  };
  const homey = {
    drivers: {
      getDriver: (id) => {
        if (!drivers[id]) throw Error(`no driver ${id}`);
        return { getDevices: () => drivers[id] };
      },
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
    getCapabilityValue: (c) => ({ meter_kwh_this_day: -1.5, meter_money_this_day: 0.75 }[c]),
    hasCapability: (c) => c === 'meter_money_this_day',
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

test('first tick sets every baseline; deltas follow the counters', () => {
  const { grid, bat } = makeRig();
  grid.updateEnergyBaselines(none);
  assert.deepStrictEqual(Object.keys(grid.energyBaselines), ['hour', 'day', 'month', 'year']);
  assert.ok(grid.marked.includes('energyBaselines'));
  grid.directionalMeter = { importValue: 1003, exportValue: 504 };
  grid.meterPowerHome = 2007;
  bat.caps.meter_kwh_charging = 102;
  const e = grid.getEnergySince('day');
  assert.deepStrictEqual(e, {
    imported: 3, exported: 4, home: 7, charged: 2, discharged: 0,
  });
});

test('per EV: name, SoC, state; charged and discharged apart only with V2X', () => {
  const { grid, homey, drivers } = makeRig();
  const car = capDevice({
    meter_kwh_charging: 50, meter_kwh_discharging: 20, meter_kwh_this_day: 1, measure_ev_soc: 64, ev_car_state: 'away',
  });
  const plain = capDevice({ meter_kwh_charging: 10, meter_kwh_this_day: 2 });
  drivers.evCharger.push(car, plain);
  grid.updateEnergyBaselines(none);
  car.caps.meter_kwh_charging = 56;
  car.caps.meter_kwh_discharging = 25;
  const [a, b] = WidgetData.getEnergy(homey, 'day').evs;
  assert.deepStrictEqual([a.name, a.soc, a.state, a.charged, a.discharged, a.kwh], [car.id, 64, 'away', 6, 5, 1]);
  assert.deepStrictEqual([b.soc, b.state, b.charged, b.discharged, b.kwh], [null, null, null, null, 2]);
});

test('a new EV starts from now; a removed EV drops its counters', () => {
  const { grid, drivers } = makeRig();
  const car = capDevice({ meter_kwh_charging: 50 });
  drivers.evCharger.push(car);
  grid.updateEnergyBaselines(none);
  drivers.evCharger.push(capDevice({ meter_kwh_charging: 300 }));
  car.caps.meter_kwh_charging = 52;
  grid.updateEnergyBaselines(none);
  const since = grid.getEnergySince('day');
  assert.strictEqual(since[`ev_${car.id}_charged`], 2);
  assert.strictEqual(since[`ev_${drivers.evCharger[1].id}_charged`], 0);
  drivers.evCharger.pop();
  grid.updateEnergyBaselines(none);
  assert.ok(!Object.keys(grid.energyBaselines.day).some((k) => k.includes(drivers.evCharger[0].id) === false && k.startsWith('ev_')));
});

test('gas and water: the meter on the smart meter only, else all', () => {
  const { grid, homey, drivers } = makeRig();
  grid.updateEnergyBaselines(none);
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

test('money: grid meter and unit, no meter gives null', () => {
  const { grid, homey } = makeRig();
  grid.updateEnergyBaselines(none);
  const { money } = WidgetData.getEnergy(homey, 'day');
  assert.strictEqual(money.grid, 0.75);
  assert.strictEqual(money.currency, 'EUR');
  assert.strictEqual(money.solar, null);
  assert.strictEqual(money.ev, null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
