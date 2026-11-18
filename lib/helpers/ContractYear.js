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
const MeterHelpers = require('./MeterHelpers');
const TimeHelpers = require('./TimeHelpers');

const DEFAULT = '0101';

const contractStart = (driverId, settings = {}) => {
  if (!BudgetSetup.hasContract(driverId)) return null;
  const start = BudgetSetup.validStartDate(settings.start_date);
  return start && start !== DEFAULT ? start : null;
};

const contractYearStart = (dateLocal, ddmm) => MeterHelpers.periodStarts(dateLocal, Number(ddmm.slice(0, 2)), Number(ddmm.slice(2, 4)) - 1).year;

const isNewContract = (reading, lastReadingContract, ddmm) => {
  if (!ddmm || !lastReadingContract) return false;
  const start = contractYearStart(new Date(reading.year, reading.month, reading.day), ddmm);
  return new Date(lastReadingContract.year, lastReadingContract.month, lastReadingContract.day) < start;
};

const localStartMs = (dateLocal, timeZone) => TimeHelpers.getLocalMidnightUTC(
  new Date(Date.UTC(dateLocal.getFullYear(), dateLocal.getMonth(), dateLocal.getDate(), 12)),
  timeZone,
).getTime();

const DAY_MS = 24 * 3600 * 1000;

const pointsOf = async (api, log, ms, cache) => {
  const year = new Date().getUTCFullYear();
  const resolutions = ['thisYear'];
  if (ms < Date.UTC(year, 0, 1) + DAY_MS) resolutions.push('lastYear');
  if (ms < Date.UTC(year - 1, 0, 1) + DAY_MS) resolutions.push('last2Years');
  let pts = [];
  let step = 0;
  for (const resolution of resolutions) {
    const key = `${log.id}|${resolution}`;
    const data = cache && cache.has(key) ? cache.get(key) : await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
    if (cache) cache.set(key, data);
    const s = InsightsHistory.stepOf(data) || 0;
    const half = step / 2;
    const first = pts.length ? Math.min(...pts.map((p) => p.t - half)) : Infinity;
    const add = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => ({ t: new Date(e.t).getTime() + s / 2, v: e.v })).filter((p) => p.t + s / 2 <= first);
    if (add.length) step = Math.max(step, s);
    pts = pts.concat(add);
  }
  return { pts: pts.sort((a, b) => a.t - b.t), step };
};

const firstAfter = (pts, step, ms, orFirst) => {
  const after = pts.findIndex((p) => p.t >= ms);
  if (after === 0 && pts[0].t > ms && !orFirst && pts[0].t - ms > step) return -1;
  return after;
};

const meterAt = async (api, deviceId, caps, ms, { orFirst = false, cache = null } = {}) => {
  const logsKey = `logs|${deviceId}|${caps.join(',')}`;
  const logs = cache && cache.has(logsKey) ? cache.get(logsKey) : await InsightsHistory.deviceLogs(api, deviceId, caps);
  if (cache) cache.set(logsKey, logs);
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
  contractStart,
  contractYearStart,
  isNewContract,
  localStartMs,
  meterAt,
};
