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

const TimeHelpers = require('./TimeHelpers');

// Work that is not time-critical (charts) out of the burst after each quarter boundary (polls,
// price slot, plans; measured up to +13 MB heap on HomeyDev 2026-10-19): to a random moment per
// device in the SPREAD_MS after the burst.
const SLOT_MIN = 15;
const BURST_MS = 90 * 1000;
const SPREAD_MS = 120 * 1000;

const inBurst = (now, timeZone) => now - TimeHelpers.startOfLocalBlock(now, SLOT_MIN, timeZone) < BURST_MS;

/**
 * Runs fn now, or after the burst when called in it: once per device and key, the latest fn.
 * @param {object} device - Homey device (homey, error, isDestroyed)
 * @param {string} key
 * @param {function} fn - async
 * @returns {Promise} fn's result now; later: resolved at once
 */
const run = (device, key, fn) => {
  const tz = device.timeZone || device.homey.clock.getTimezone();
  const now = Date.now();
  if (!inBurst(now, tz)) return fn();
  if (!device.spreadTasks) device.spreadTasks = {};
  const pending = device.spreadTasks[key];
  if (pending) {
    pending.fn = fn;
    return Promise.resolve();
  }
  const task = { fn };
  device.spreadTasks[key] = task;
  const at = TimeHelpers.startOfLocalBlock(now, SLOT_MIN, tz) + BURST_MS + (Math.random() * SPREAD_MS);
  device.homey.setTimeout(() => {
    delete device.spreadTasks[key];
    if (device.isDestroyed) return;
    Promise.resolve().then(() => task.fn()).catch((err) => device.error(err));
  }, at - now);
  return Promise.resolve();
};

module.exports = { run, inBurst };
