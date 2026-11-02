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

// Promise-chain queues for runExclusive() below, keyed by caller-supplied string.
const exclusiveChains = new Map();

module.exports = {
  // Serializes async work per key: same-key calls run one at a time, in order. A tariff broadcast
  // handler is re-entrant (homey.emit() does not wait), and overlapping runs could hand a device the
  // older tariff last. Returns the call's own promise, so flow cards can await completion.
  runExclusive: (key, fn) => {
    const previous = exclusiveChains.get(key) || Promise.resolve();
    // .then(fn, fn) so a rejected predecessor still lets the next one run.
    const result = previous.then(fn, fn);
    const tail = result.catch(() => {});
    exclusiveChains.set(key, tail);
    // Drop the entry once it is both settled and still the tail, so the map can't grow forever.
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

  // onUninit: lets a running migration finish (an app stop or update mid-write), at most maxMs.
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
      // ignore driver fetch errors
    }
    return null;
  },
};
