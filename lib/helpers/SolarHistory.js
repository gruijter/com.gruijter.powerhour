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

const InsightsHistory = require('./InsightsHistory');
const TimeHelpers = require('./TimeHelpers');

const H = 3600 * 1000;
const STEP = 6 * H;

const bounds = (year, timeZone, nowMs = Date.now()) => {
  const todayMs = TimeHelpers.getLocalMidnightUTC(new Date(nowMs), timeZone).getTime();
  const days = [];
  let ms = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(year, 0, 1, 12)), timeZone).getTime();
  while (ms < todayMs && days.length < 366) {
    const next = TimeHelpers.getLocalMidnightUTC(new Date(ms + 26 * H), timeZone).getTime();
    days.push({ doy: days.length, ms, next });
    ms = next;
  }
  const set = new Set(days.flatMap((d) => [d.ms, d.next]));
  if (days.length) {
    for (let t = Math.ceil(days[0].ms / STEP) * STEP; t < todayMs; t += STEP) set.add(t);
  }
  return { days, points: [...set].sort((a, b) => a - b) };
};

const meterValues = async (api, deviceId, caps, points) => {
  const logs = await InsightsHistory.deviceLogs(api, deviceId, caps);
  for (const log of logs) {
    let data = await api.insights.getLogEntries({ id: log.id, resolution: 'thisYear' }).catch(() => null);
    const step = InsightsHistory.stepOf(data);
    let pts = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => [new Date(e.t).getTime() + (step || 0) / 2, e.v]);
    data = null;
    if (pts.length < 2 || !step) continue; // eslint-disable-line no-continue
    const out = new Array(points.length).fill(null);
    let j = 0;
    points.forEach((t, i) => {
      if (t < pts[0][0] - step / 2 || t > pts[pts.length - 1][0] + step) return;
      while (j < pts.length - 2 && pts[j + 1][0] < t) j += 1;
      const [ta, va] = pts[j];
      const [tb, vb] = pts[j + 1];
      if (t <= ta) out[i] = va;
      else if (t >= tb) out[i] = vb;
      else out[i] = va + ((vb - va) * (t - ta)) / (tb - ta);
    });
    pts = null;
    return out;
  }
  return null;
};

const combine = (series) => {
  if (!series.length || series.some((s) => !s.values)) return null;
  return series[0].values.map((_, i) => {
    let total = 0;
    for (const s of series) {
      if (typeof s.values[i] !== 'number') return null;
      total += s.sign * s.values[i];
    }
    return total;
  });
};

const hourlyEntries = async (api, deviceId, cap) => {
  const [log] = await InsightsHistory.deviceLogs(api, deviceId, [cap]);
  if (!log) return new Map();
  for (const resolution of ['last14Days', 'last7Days']) {
    const data = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
    if (InsightsHistory.stepOf(data) === H) {
      return new Map(data.values.filter((e) => typeof e.v === 'number').map((e) => [new Date(e.t).getTime(), e.v]));
    }
  }
  return new Map();
};

const dayEndValues = async (api, deviceId, cap, days, { lastCap = null, monotonic = false } = {}) => {
  const day = await hourlyEntries(api, deviceId, cap);
  if (!day.size) return new Map();
  const last = lastCap ? await hourlyEntries(api, deviceId, lastCap) : new Map();
  const out = new Map();
  days.forEach(({ doy, next }) => {
    const end = day.get(next - H);
    if (typeof end !== 'number') return;
    if (day.get(next - 2 * H) === end) out.set(doy, end);
    else if (typeof last.get(next + H) === 'number' && (!monotonic || last.get(next + H) >= end)) out.set(doy, last.get(next + H));
  });
  return out;
};

const monthEndValues = async (api, deviceId, cap, year, timeZone, { lastCap = null } = {}) => {
  const out = new Array(12).fill(null);
  const entriesOf = async (name) => {
    const [log] = await InsightsHistory.deviceLogs(api, deviceId, [name]);
    if (!log) return { step: null, entries: [] };
    const data = await api.insights.getLogEntries({ id: log.id, resolution: 'thisYear' }).catch(() => null);
    return {
      step: InsightsHistory.stepOf(data),
      entries: ((data && data.values) || []).filter((e) => typeof e.v === 'number').map((e) => [new Date(e.t).getTime(), e.v]),
    };
  };
  const { step, entries } = await entriesOf(cap);
  if (!step) return out;
  const last = lastCap ? await entriesOf(lastCap) : { step: null, entries: [] };
  const nowMonth = TimeHelpers.toLocalDate(new Date(), timeZone).getMonth();
  for (let m = 0; m < nowMonth; m += 1) {
    const start = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(year, m, 1, 12)), timeZone).getTime();
    const end = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(year, m + 1, 1, 12)), timeZone).getTime();
    const near = last.entries.filter(([t]) => t >= end && t < end + 7 * 24 * H);
    const after = near.find(([t]) => t >= end + last.step) || near[0];
    const inMonth = entries.filter(([t]) => t >= start && t + step <= end);
    if (after) out[m] = after[1];
    else if (inMonth.length) out[m] = inMonth[inMonth.length - 1][1];
  }
  return out;
};

const dayDeltas = (seriesList, days, points, maxKwh) => {
  const index = new Map(points.map((t, i) => [t, i]));
  const list = seriesList.filter(Boolean);
  const out = new Map();
  days.forEach(({ doy, ms, next }) => {
    const found = list.find((s) => typeof s[index.get(ms)] === 'number' && typeof s[index.get(next)] === 'number'
      && s[index.get(next)] - s[index.get(ms)] >= -0.05 && s[index.get(next)] - s[index.get(ms)] <= maxKwh);
    if (found) out.set(doy, { kwh: Math.max(0, Math.round((found[index.get(next)] - found[index.get(ms)]) * 1000) / 1000), series: found });
  });
  return out;
};

const deviceDays = async (api, device, days, points) => {
  const own = await meterValues(api, device.getId(), device.ownMeterCaps(), points);
  const group = device.sourceCapGroup || {};
  const sourceId = device.getSettings().homey_device_id;
  const roles = [['p1', 1], ['p2', 1], ['n1', -1], ['n2', -1]].filter(([role]) => group[role]);
  let source = null;
  if (sourceId && roles.length && !device.getSettings().use_measure_source) {
    const parts = [];
    for (const [role, sign] of roles) parts.push({ sign, values: await meterValues(api, sourceId, [group[role]], points) });
    source = combine(parts);
  }
  const peak = device.chartPeak ? device.chartPeak() : 0;
  const kwh = new Array(366).fill(null);
  const use = new Array(366).fill(null);
  dayDeltas([own, source], days, points, peak > 0 ? (peak * 12) / 1000 : 500).forEach((d, doy) => {
    kwh[doy] = d.kwh;
    use[doy] = d.series;
  });
  return { kwh, use };
};

const fill = async (driver, homeyApi) => {
  const api = InsightsHistory.tracked(homeyApi);
  const all = driver.getDevices().filter((d) => typeof d.dayLogFor === 'function' && d.fileStore);
  const pending = all.filter((d) => d.historyPending());
  if (!pending.length) return null;
  const { timeZone } = pending[0];
  const year = TimeHelpers.toLocalDate(new Date(), timeZone).getFullYear();
  const { days, points } = bounds(year, timeZone);
  const index = new Map(points.map((t, i) => [t, i]));

  const solar = [];
  for (const device of all) solar.push({ device, ...(await deviceDays(api, device, days, points)) });

  let exported = null;
  let grid = null;
  try {
    [grid] = driver.homey.drivers.getDriver('grid').getDevices();
  } catch {
    grid = null;
  }
  const gridGroup = (grid && grid.sourceCapGroup) || {};
  const gridSource = grid && grid.getSettings().homey_device_id;
  const exportCaps = ['n1', 'n2'].map((role) => gridGroup[role]).filter(Boolean);
  if (gridSource && exportCaps.length) {
    const parts = [];
    for (const cap of exportCaps) parts.push({ sign: 1, values: await meterValues(api, gridSource, [cap], points) });
    exported = combine(parts);
  }
  let batteries = [];
  try {
    batteries = driver.homey.drivers.getDriver('battery').getDevices();
  } catch {
    batteries = [];
  }
  let discharged = new Array(points.length - 1).fill(0);
  for (const bat of batteries) {
    let own = await meterValues(api, bat.getId(), ['meter_kwh_discharging'], points);
    const srcCap = bat.sourceCapGroup && bat.sourceCapGroup.meterDischarging;
    const srcId = bat.getSettings().homey_device_id;
    let src = srcCap && srcId ? await meterValues(api, srcId, [srcCap], points) : null;
    for (let i = 0; i < discharged.length; i += 1) {
      for (const series of [own, src]) {
        if (series && typeof series[i] === 'number' && typeof series[i + 1] === 'number') {
          discharged[i] += Math.max(0, series[i + 1] - series[i]);
          break;
        }
      }
    }
    own = null;
    src = null;
  }

  const estShare = new Array(366).fill(null);
  if (exported) {
    days.forEach(({ doy, ms, next }) => {
      const live = solar.filter((x) => x.use[doy] !== null);
      if (!live.length) return;
      let own = 0;
      let total = 0;
      for (let i = index.get(ms); i < index.get(next); i += 1) {
        if (live.some((x) => typeof x.use[doy][i + 1] !== 'number' || typeof x.use[doy][i] !== 'number')) return;
        const s = live.reduce((sum, x) => sum + Math.max(0, x.use[doy][i + 1] - x.use[doy][i]), 0);
        const e = typeof exported[i + 1] === 'number' && typeof exported[i] === 'number' ? Math.max(0, exported[i + 1] - exported[i]) : null;
        if (e === null) return;
        if (s > 0.1 && discharged[i] > 0.1 * s) return;
        own += Math.max(0, s - e);
        total += s;
      }
      estShare[doy] = total > 0 ? Math.min(1, own / total) : 1;
    });
  }
  exported = null;
  discharged = null;

  let filled = 0;
  const counts = [];
  for (const s of solar) {
    const { device } = s;
    if (!device.historyPending()) continue; // eslint-disable-line no-continue
    const log = device.dayLogFor(year);
    const share = await dayEndValues(api, device.getId(), 'measure_solar_use.this_day', days);
    const money = await dayEndValues(api, device.getId(), 'meter_money_this_day', days);
    const mShare = await monthEndValues(api, device.getId(), 'measure_solar_use.this_month', year, timeZone);
    const mMoney = await monthEndValues(api, device.getId(), 'meter_money_this_month', year, timeZone);
    const mKwh = await monthEndValues(api, device.getId(), 'meter_kwh_this_month', year, timeZone);
    for (let m = 0; m < 12; m += 1) {
      if (log.mShare[m] < 0 && typeof mShare[m] === 'number') log.mShare[m] = Math.min(1, Math.max(0, mShare[m] / 100));
      if (log.mValue[m] < 0 && typeof mMoney[m] === 'number' && mKwh[m] > 0) log.mValue[m] = mMoney[m] / mKwh[m];
    }
    const yearAvg = device.hasCapability('meter_money_this_year_avg') ? device.getCapabilityValue('meter_money_this_year_avg') : null;
    const valueOf = (m) => {
      for (let k = 0; k < 12; k += 1) {
        for (const mm of [m - k, m + k]) if (mm >= 0 && mm < 12 && log.mValue[mm] >= 0) return log.mValue[mm];
      }
      return typeof yearAvg === 'number' && yearAvg > 0 ? yearAvg : null;
    };
    for (const { doy, ms } of days) {
      if (log.est[doy] === 0 && log.kwh[doy] >= 0) continue; // eslint-disable-line no-continue
      const kwh = s.kwh[doy];
      if (typeof kwh !== 'number') continue; // eslint-disable-line no-continue
      const month = TimeHelpers.toLocalDate(new Date(ms + 12 * H), timeZone).getMonth();
      const sh = share.has(doy) ? share.get(doy) / 100 : estShare[doy];
      let value = money.has(doy) ? money.get(doy) : valueOf(month);
      if (!money.has(doy) && typeof value === 'number') value *= kwh;
      log.kwh[doy] = kwh;
      log.own[doy] = typeof sh === 'number' ? Math.round(kwh * Math.min(1, Math.max(0, sh)) * 1000) / 1000 : -1;
      log.money[doy] = typeof value === 'number' ? Math.round((value === -1 ? -1.0001 : value) * 10000) / 10000 : -1;
      log.est[doy] = share.has(doy) && money.has(doy) ? 0 : 1;
      filled += 1;
    }
    await device.saveDayLog();
    if (!api.failed) await device.setHistoryDone();
    const known = log.kwh.filter((k) => k >= 0).length;
    counts.push(`${device.getName ? device.getName() : device.getId()}: ${known} days, own use ${log.own.filter((v) => v >= 0).length}, exact ${log.est.filter((v) => v === 0).length}`);
  }
  return api.failed ? { filled, devices: counts, retry: true } : { filled, devices: counts };
};

module.exports = {
  bounds, meterValues, combine, dayDeltas, fill, dayEndValues, monthEndValues,
};
