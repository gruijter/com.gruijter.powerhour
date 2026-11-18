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

// The solar day log (yield, own use and value per day of this year, for widgets/solar) rebuilt once
// from Insights, for all solar devices together. Memory: one log is fetched at a time and reduced at
// once to its values at the day and 6-hour bounds (~1600 numbers); P1 and batteries once for all.
//
// Per day, exact where the device logged it (its own hourly share and money logs: 14 days), else an
// estimate per 6-hour bucket (Insights has no finer data for this year): own use = solar - export,
// the live split (solar driver.js); a solar device or battery without meter data then (not logging
// yet) counts none. A bucket with solar in which batteries discharge more than 10%
// of it cannot be told apart from battery export: then the day's own use stays unknown. Value of an
// estimated day: its kWh x the device's value per kWh of that month (its month counters at the
// month end), else of the nearest month that has one, else its average this year.

const InsightsHistory = require('./InsightsHistory');
const TimeHelpers = require('./TimeHelpers');

const H = 3600 * 1000;
const STEP = 6 * H;

// Local days of this year until today [{ doy, ms, next }], and the sorted points: those bounds and
// the 6-hour UTC grid between them.
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

// A cumulative meter's values at the points from one log (resolution thisYear), null where the log
// does not reach. Entries are bucket means: the value at the bucket centre. null without a log.
const meterValues = async (api, deviceId, caps, points) => {
  const logs = await InsightsHistory.deviceLogs(api, deviceId, caps);
  for (const log of logs) {
    let data = await api.insights.getLogEntries({ id: log.id, resolution: 'thisYear' }).catch(() => null);
    const step = InsightsHistory.stepOf(data);
    let pts = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => [new Date(e.t).getTime() + (step || 0) / 2, e.v]);
    data = null; // the raw entries go now
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

// The sum of several meters' values (sign per meter), null at a point where one is missing.
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

// A log's hourly value in the hour before each day's end (last14Days): the day's final value of a
// counter that resets at midnight. Map doy -> value.
const dayEndValues = async (api, deviceId, cap, days) => {
  const [log] = await InsightsHistory.deviceLogs(api, deviceId, [cap]);
  if (!log) return new Map();
  const data = await api.insights.getLogEntries({ id: log.id, resolution: 'last14Days' }).catch(() => null);
  if (InsightsHistory.stepOf(data) !== H) return new Map();
  const byStart = new Map(((data && data.values) || []).filter((e) => typeof e.v === 'number')
    .map((e) => [new Date(e.t).getTime(), e.v]));
  const out = new Map();
  days.forEach(({ doy, next }) => {
    if (byStart.has(next - H)) out.set(doy, byStart.get(next - H));
  });
  return out;
};

// A log's value in the last bucket that ends by each past month's end (thisYear): [12], null unknown.
const monthEndValues = async (api, deviceId, cap, year, timeZone) => {
  const out = new Array(12).fill(null);
  const [log] = await InsightsHistory.deviceLogs(api, deviceId, [cap]);
  if (!log) return out;
  const data = await api.insights.getLogEntries({ id: log.id, resolution: 'thisYear' }).catch(() => null);
  const step = InsightsHistory.stepOf(data);
  if (!step) return out;
  const entries = ((data && data.values) || []).filter((e) => typeof e.v === 'number').map((e) => [new Date(e.t).getTime(), e.v]);
  const nowMonth = TimeHelpers.toLocalDate(new Date(), timeZone).getMonth();
  for (let m = 0; m < nowMonth; m += 1) {
    const start = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(year, m, 1, 12)), timeZone).getTime();
    const end = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(year, m + 1, 1, 12)), timeZone).getTime();
    const inMonth = entries.filter(([t]) => t >= start && t + step <= end);
    if (inMonth.length) out[m] = inMonth[inMonth.length - 1][1];
  }
  return out;
};

// kWh per day [366] of a device from its own meter, else its source's meters (zero points differ:
// one meter per day); a day above peak x 12 h is a meter jump, a few Wh down is noise (0). Also the
// series used per day, for the buckets. null kWh: unknown.
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
  const index = new Map(points.map((t, i) => [t, i]));
  const peak = device.chartPeak ? device.chartPeak() : 0;
  const maxKwh = peak > 0 ? (peak * 12) / 1000 : 500;
  const kwh = new Array(366).fill(null);
  const use = new Array(366).fill(null); // the series of each day
  days.forEach(({ doy, ms, next }) => {
    for (const series of [own, source]) {
      const a = series ? series[index.get(ms)] : null;
      const b = series ? series[index.get(next)] : null;
      if (typeof a === 'number' && typeof b === 'number' && b - a >= -0.05 && b - a <= maxKwh) {
        kwh[doy] = Math.max(0, Math.round((b - a) * 1000) / 1000);
        use[doy] = series;
        return;
      }
    }
  });
  return { kwh, use };
};

// Rebuilds the day log of the solar devices that need it (device.historyPending()). Never rejects
// for a single device: what cannot be read stays unknown.
const fill = async (driver, api) => {
  // Started devices (onInit opened their file store).
  const all = driver.getDevices().filter((d) => typeof d.dayLogFor === 'function' && d.fileStore);
  const pending = all.filter((d) => d.historyPending());
  if (!pending.length) return null;
  const { timeZone } = pending[0];
  const year = TimeHelpers.toLocalDate(new Date(), timeZone).getFullYear();
  const { days, points } = bounds(year, timeZone);
  const index = new Map(points.map((t, i) => [t, i]));

  // Solar per device (all devices: the export is shared by all of them).
  const solar = [];
  for (const device of all) solar.push({ device, ...(await deviceDays(api, device, days, points)) });

  // Export of the home (the Grid Monitor's source meter) and the batteries' discharge.
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
  // Battery discharge per bucket: the own meter, else the source's (their zero points differ: per
  // bucket); a battery without data in a bucket (not logging yet) counts none.
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

  // Own use share per day from the 6-hour buckets: null when unknown.
  const estShare = new Array(366).fill(null);
  if (exported) {
    days.forEach(({ doy, ms, next }) => {
      // A device without meter data that day (not logging yet): no yield counted.
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
      estShare[doy] = total > 0 ? Math.min(1, own / total) : 1; // no solar: nothing exported
    });
  }
  exported = null;
  discharged = null;

  // Per pending device: exact days and months from its own logs, then the estimates.
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
    // Value per kWh: of that month, else the nearest month, else the device's average this year.
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
      log.money[doy] = typeof value === 'number' ? Math.round(value * 10000) / 10000 : -1;
      log.est[doy] = share.has(doy) && money.has(doy) ? 0 : 1;
      filled += 1;
    }
    await device.saveDayLog();
    await device.setHistoryDone();
    const known = log.kwh.filter((k) => k >= 0).length;
    counts.push(`${device.getName ? device.getName() : device.getId()}: ${known} days, own use ${log.own.filter((v) => v >= 0).length}, exact ${log.est.filter((v) => v === 0).length}`);
  }
  return { filled, devices: counts };
};

module.exports = {
  bounds, meterValues, combine, fill, dayEndValues, monthEndValues,
};
