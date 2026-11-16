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

const BudgetSetup = require('./BudgetSetup');
const InsightsHistory = require('./InsightsHistory');
const TimeHelpers = require('./TimeHelpers');

const DEFAULT = '0101';
const SETTING = 'contractStart';

const saved = (homey) => homey.settings.get(SETTING) || null;
const save = (homey, start) => homey.settings.set(SETTING, start);

// One contract year and month for the whole app: the start date ('ddmm') of the grid device.
const startDate = (homey) => {
  let grids = [];
  try {
    grids = homey.drivers.getDriver('grid').getDevices();
  } catch {
    // grid driver not loaded
  }
  if (!grids.length) return saved(homey) || DEFAULT;
  return BudgetSetup.validStartDate(grids[0].getSettings().start_date) || DEFAULT;
};

// The grid start date changed, or a grid device came or went: every other meter follows.
const changed = async (homey) => {
  const drivers = Object.entries(homey.drivers.getDrivers()).filter(([id]) => id !== 'grid');
  for (const [, driver] of drivers) {
    for (const device of driver.getDevices()) {
      if (typeof device.followContractStart === 'function') await device.followContractStart().catch((err) => device.error(err));
    }
  }
};

// UTC ms of local midnight of a local date (wall-clock fields).
const localStartMs = (dateLocal, timeZone) => TimeHelpers.getLocalMidnightUTC(
  new Date(Date.UTC(dateLocal.getFullYear(), dateLocal.getMonth(), dateLocal.getDate(), 12)),
  timeZone,
).getTime();

const DAY_MS = 24 * 3600 * 1000;

// The points { t (bucket centre), v } of a log around ms, sorted, with its step. thisYear and
// lastYear are calendar years (UTC): near or before the year start both. cache: a Map of entries.
const pointsOf = async (api, log, ms, cache) => {
  const yearStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
  const resolutions = ms < yearStart + DAY_MS ? ['lastYear', 'thisYear'] : ['thisYear'];
  let pts = [];
  let step = 0;
  for (const resolution of resolutions) {
    const key = `${log.id}|${resolution}`;
    const data = cache && cache.has(key) ? cache.get(key) : await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
    if (cache) cache.set(key, data);
    const s = InsightsHistory.stepOf(data) || 0;
    step = Math.max(step, s);
    pts = pts.concat(((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => ({ t: new Date(e.t).getTime() + s / 2, v: e.v })));
  }
  return { pts: pts.sort((a, b) => a.t - b.t), step };
};

// The index of the first point at or after ms, -1 without. A log whose first point is within a
// step after ms (a year start at the start of a range) counts from that point.
const firstAfter = (pts, step, ms, orFirst) => {
  const after = pts.findIndex((p) => p.t >= ms);
  if (after === 0 && pts[0].t > ms && !orFirst && pts[0].t - ms > step) return -1;
  return after;
};

// A meter's value at ms from Insights (entries are bucket means: value at the bucket centre), from
// the first log of caps with data around ms. orFirst: a log that starts later gives its first value.
// null without.
// cache: a Map for several calls on the same logs.
const meterAt = async (api, deviceId, caps, ms, { orFirst = false, cache = null } = {}) => {
  const logs = await InsightsHistory.deviceLogs(api, deviceId, caps);
  for (const log of logs) {
    const { pts, step } = await pointsOf(api, log, ms, cache);
    const after = firstAfter(pts, step, ms, orFirst);
    if (after === 0) return pts[0].v;
    if (after > 0) {
      const a = pts[after - 1];
      const b = pts[after];
      return a.v + ((b.v - a.v) * (ms - a.t)) / (b.t - a.t);
    }
  }
  return null;
};

// A rising counter's growth from ms till now (nowValue: its value now), drops skipped: a counter
// only rises, a drop is a reset. From the first log of caps that reaches back to ms; orFirst: from
// the first value of a log that starts later. null without.
const growthSince = async (api, deviceId, caps, ms, { nowValue = null, orFirst = false, cache = null } = {}) => {
  const logs = await InsightsHistory.deviceLogs(api, deviceId, caps);
  for (const log of logs) {
    const { pts, step } = await pointsOf(api, log, ms, cache);
    const after = firstAfter(pts, step, ms, orFirst);
    if (after < 0) continue;
    let prev = after === 0 ? pts[0].v
      : pts[after - 1].v + ((pts[after].v - pts[after - 1].v) * (ms - pts[after - 1].t)) / (pts[after].t - pts[after - 1].t);
    let growth = 0;
    for (let i = after; i < pts.length; i += 1) {
      if (pts[i].v > prev) growth += pts[i].v - prev;
      prev = pts[i].v;
    }
    if (typeof nowValue === 'number' && nowValue > prev) growth += nowValue - prev;
    return growth;
  }
  return null;
};

// Insights jobs (restores, rebases) one at a time for the whole app: all devices start together.
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

module.exports = {
  serial,
  growthSince,
  DEFAULT,
  saved,
  save,
  startDate,
  changed,
  localStartMs,
  meterAt,
};
