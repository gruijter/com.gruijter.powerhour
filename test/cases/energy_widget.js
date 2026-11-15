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
    getCapabilityValue: (c) => ({ meter_kwh_this_day: -1.5 }[c]),
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

test('a new hour moves only the hour baseline', () => {
  const { grid } = makeRig();
  grid.updateEnergyBaselines(none);
  grid.meterPowerHome = 2005;
  grid.updateEnergyBaselines({ ...none, newHour: true });
  grid.meterPowerHome = 2006;
  assert.strictEqual(grid.getEnergySince('hour').home, 1);
  assert.strictEqual(grid.getEnergySince('day').home, 6);
});

test('a falling counter (battery removed) restarts from now, never negative', () => {
  const { grid, drivers } = makeRig();
  grid.updateEnergyBaselines(none);
  drivers.battery = [];
  assert.strictEqual(grid.getEnergySince('day').charged, null);
  drivers.battery = [capDevice({ meter_kwh_charging: 5, meter_kwh_discharging: 1 })];
  assert.strictEqual(grid.getEnergySince('day').charged, 0);
  grid.updateEnergyBaselines(none);
  drivers.battery[0].caps.meter_kwh_charging = 6;
  assert.strictEqual(grid.getEnergySince('day').charged, 1);
});

test('a battery added with a high lifetime counter does not count its history', () => {
  const { grid, drivers } = makeRig();
  grid.updateEnergyBaselines(none);
  drivers.battery.push(capDevice({ meter_kwh_charging: 500, meter_kwh_discharging: 400 }));
  assert.strictEqual(grid.getEnergySince('day').charged, 0);
  grid.updateEnergyBaselines(none);
  drivers.battery[1].caps.meter_kwh_charging = 503;
  assert.strictEqual(grid.getEnergySince('day').charged, 3);
  assert.strictEqual(grid.getEnergySince('year').charged, 3);
});

test('no import/export data: split null, net from the meter', () => {
  const { grid, homey } = makeRig();
  grid.directionalMeter = { importValue: null, exportValue: null };
  grid.updateEnergyBaselines(none);
  const e = WidgetData.getEnergy(homey, 'day');
  assert.strictEqual(e.imported, null);
  assert.strictEqual(e.net, -1.5);
  assert.strictEqual(e.solar, 12.5);
  assert.strictEqual(e.gasM3, 3);
  assert.strictEqual(e.ev, null);
  assert.strictEqual(WidgetData.getEnergy(homey, 'bogus').period, 'day');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
