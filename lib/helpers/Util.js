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
  // Serialises async work per key: two calls with the same key never overlap and run in the
  // order they arrived, while different keys still run concurrently.
  //
  // Needed because a tariff broadcast handler is re-entrant: homey.emit() fires it again as soon
  // as the next broadcast arrives, without waiting for the previous one to finish, and the
  // handler is full of await points (a 2s settling delay, then a per-device loop with its own
  // awaits). Two overlapping runs for the same driver produced two independent loops writing the
  // same devices, so a device could be handed the OLDER broadcast last: updateTariffHistory()
  // then records that older tariff as `current` and moves `currentTm` BACKWARDS, which also
  // corrupts the crossedBoundary check on every following update. Concurrent calls on one device
  // could additionally lose an update outright - both read this.tariffHistory, both write it.
  //
  // Returns the wrapped call's own promise, so awaiting callers (a flow's "Set Tariff" action
  // card, via Flows.js) still get the real completion signal, now including the queue wait.
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
      setTimeout(resolve, delay);
    }
  }),

  getGridPowerFallback: (homey) => {
    try {
      const gridDriver = homey.drivers.getDriver('grid');
      if (gridDriver) {
        const gridDevices = gridDriver.getDevices();
        if (gridDevices && gridDevices.length > 0) {
          for (const gridDev of gridDevices) {
            const livePower = gridDev.getCapabilityValue('measure_power.grid');
            if (typeof livePower === 'number') return livePower;
          }
        }
      }
    } catch (e) {
      // ignore driver fetch errors
    }
    return null;
  },
};
