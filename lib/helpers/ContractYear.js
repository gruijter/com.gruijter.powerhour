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

// A meter's value at ms from Insights (entries are bucket means: value at the bucket centre), from
// the first log of caps with data around ms. orFirst: a log that starts later gives its first value.
// null without.
const meterAt = async (api, deviceId, caps, ms, { orFirst = false } = {}) => {
  const year = new Date(ms).getUTCFullYear();
  const resolution = year === new Date().getUTCFullYear() ? 'thisYear' : 'lastYear';
  const logs = await InsightsHistory.deviceLogs(api, deviceId, caps);
  for (const log of logs) {
    const data = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
    const step = InsightsHistory.stepOf(data) || 0;
    const pts = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => ({ t: new Date(e.t).getTime() + step / 2, v: e.v }));
    const after = pts.findIndex((p) => p.t >= ms);
    if (after === 0 && orFirst) return pts[0].v;
    if (after > 0) {
      const a = pts[after - 1];
      const b = pts[after];
      return a.v + ((b.v - a.v) * (ms - a.t)) / (b.t - a.t);
    }
  }
  return null;
};

module.exports = {
  DEFAULT,
  saved,
  save,
  startDate,
  changed,
  localStartMs,
  meterAt,
};
