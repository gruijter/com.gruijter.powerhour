/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const exclusiveChains = new Map();

module.exports = {
  runExclusive: (key, fn) => {
    const previous = exclusiveChains.get(key) || Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.catch(() => {});
    exclusiveChains.set(key, tail);
    tail.then(() => {
      if (exclusiveChains.get(key) === tail) exclusiveChains.delete(key);
    });
    return result;
  },

  setTimeoutPromise: (delay, context) => new Promise((resolve) => {
    if (context && context.homey && context.homey.setTimeout) {
      context.homey.setTimeout(resolve, delay);
    } else {
      setTimeout(resolve, delay); // eslint-disable-line homey-app/global-timers -- fallback without a Homey instance; self-clearing
    }
  }),

  awaitMigration: (device, maxMs = 3000) => {
    if (!device.migration) return Promise.resolve();
    return Promise.race([device.migration.catch(() => {}), module.exports.setTimeoutPromise(maxMs, device)]);
  },

  getGridPowerFallback: (homey) => {
    try {
      const gridDriver = homey.drivers.getDriver('grid');
      if (gridDriver) {
        const gridDevices = gridDriver.getDevices();
        if (gridDevices && gridDevices.length > 0) {
          for (const gridDev of gridDevices) {
            const livePower = gridDev.getCapabilityValue('measure_watt_grid');
            if (typeof livePower === 'number') return livePower;
          }
        }
      }
    } catch {
    }
    return null;
  },
};
