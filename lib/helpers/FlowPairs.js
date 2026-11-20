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

const ContractYear = require('./ContractYear');
const DayLog = require('./DayLog');
const FileStore = require('./FileStore');
const InsightsHistory = require('./InsightsHistory');
const TimeHelpers = require('./TimeHelpers');

const KEY = 'flowPairs';
const HISTORY_KEY = 'flowPairsFilled';
const VERSION = 1;
const FILL_VERSION = 1;
const SRC = ['grid', 'solar', 'battery', 'ev'];
const DST = ['export', 'battery', 'ev', 'home'];
const PAIRS = SRC.flatMap((s) => DST.map((d) => `${s}_${d}`));
const FIELDS = [...PAIRS, 'src'];
const HOUR_MS = 3600 * 1000;
const MAX_GAP_MS = 5 * 60 * 1000;
const CAPS = {
  grid: 'measure_watt_grid', solar: 'measure_watt_solar', battery: 'measure_watt_battery', ev: 'measure_watt_evcharger',
};
const LIVE = 2;
const REBUILT = 1;

const split = ({
  grid = 0, solar = 0, battery = 0, ev = 0,
}) => {
  const src = {
    grid: Math.max(0, grid), solar: Math.max(0, solar), battery: Math.max(0, -battery), ev: Math.max(0, -ev),
  };
  const dst = { export: Math.max(0, -grid), battery: Math.max(0, battery), ev: Math.max(0, ev) };
  const total = SRC.reduce((a, s) => a + src[s], 0);
  dst.home = Math.max(0, total - dst.export - dst.battery - dst.ev);
  const used = DST.reduce((a, d) => a + dst[d], 0);
  if (!(total > 0) || !(used > 0)) return null;
  const out = {};
  SRC.forEach((s) => DST.forEach((d) => {
    out[`${s}_${d}`] = (src[s] * dst[d]) / used;
  }));
  return out;
};

const round = (v) => Math.round(v * 100000) / 100000;

const load = async (dev) => {
  if (dev[KEY] === undefined) dev[KEY] = (await FileStore.open(dev, [KEY])).get(KEY) || null;
  return dev[KEY];
};

const dayOf = (dev, ms) => {
  const c = dev.flowPairsDay;
  if (c && ms >= c.from && ms < c.to) return c;
  const tz = dev.timeZone || dev.homey.clock.getTimezone();
  const from = TimeHelpers.getLocalMidnightUTC(new Date(ms), tz).getTime();
  const to = TimeHelpers.getLocalMidnightUTC(new Date(from + 26 * HOUR_MS), tz).getTime();
  const date = TimeHelpers.toLocalDate(new Date(from + HOUR_MS), tz);
  const year = date.getFullYear();
  const day = {
    from, to, year, doy: DayLog.doyOf(year, date.getMonth(), date.getDate()),
  };
  dev.flowPairsDay = day;
  return day;
};

const hourStartOf = (dev, ms) => {
  const { from } = dayOf(dev, ms);
  return from + Math.floor((ms - from) / HOUR_MS) * HOUR_MS;
};

const slotFor = (dev, year, doy) => {
  const log = DayLog.yearLog(dev[KEY], VERSION, year, FIELDS, []);
  if (log) dev[KEY] = log;
  return DayLog.daySlot(dev[KEY], VERSION, year, doy);
};

const addTo = (slot, pairs, hours, mark) => {
  const { log, i } = slot;
  PAIRS.forEach((p) => {
    const kwh = (pairs[p] * hours) / 1000;
    if (!(kwh > 0)) return;
    log[p][i] = round(Math.max(0, log[p][i]) + kwh);
  });
  if (mark && log.src[i] < mark) log.src[i] = mark;
};

const record = (dev, nowMs, w) => {
  if (!dev[KEY] && dev[KEY] !== null) return;
  const last = dev.flowPairsLast;
  dev.flowPairsLast = { t: nowMs, w };
  if (!last || nowMs - last.t > MAX_GAP_MS || nowMs <= last.t) return;
  const pairs = split(last.w);
  if (!pairs) return;
  const hours = (nowMs - last.t) / HOUR_MS;
  const hourStart = hourStartOf(dev, last.t);
  if (!dev.flowPairsHour || dev.flowPairsHour.start !== hourStart) dev.flowPairsHour = { start: hourStart, kwh: {} };
  PAIRS.forEach((p) => {
    dev.flowPairsHour.kwh[p] = (dev.flowPairsHour.kwh[p] || 0) + (pairs[p] * hours) / 1000;
  });
  const day = dayOf(dev, last.t);
  const slot = slotFor(dev, day.year, day.doy);
  if (!slot) return;
  addTo(slot, pairs, hours, LIVE);
  FileStore.open(dev).then((files) => files.set(KEY, dev[KEY])).catch((err) => dev.error(err));
};

const toMatrix = (sum) => {
  const out = {};
  SRC.forEach((s) => {
    out[s] = {};
    DST.forEach((d) => {
      out[s][d] = round(sum[`${s}_${d}`] || 0);
    });
  });
  return out;
};

const period = (dev, p) => {
  if (!dev || !dev[KEY]) return null;
  if (p === 'hour') {
    const h = dev.flowPairsHour;
    return h && h.start === hourStartOf(dev, Date.now()) ? toMatrix(h.kwh) : null;
  }
  const today = dayOf(dev, Date.now());
  const log = dev[KEY];
  if (log.v !== VERSION || log.year !== today.year) return null;
  let from = today.doy;
  if (p === 'month') {
    const date = TimeHelpers.toLocalDate(new Date(today.from + HOUR_MS), dev.timeZone || dev.homey.clock.getTimezone());
    from = DayLog.doyOf(today.year, date.getMonth(), 1);
  } else if (p === 'year') from = 0;
  const sum = {};
  let days = 0;
  for (let i = from; i <= today.doy; i += 1) {
    if (log.src[i] > 0) {
      days += 1;
      PAIRS.forEach((k) => {
        if (log[k][i] > 0) sum[k] = (sum[k] || 0) + log[k][i];
      });
    }
  }
  return days ? toMatrix(sum) : null;
};

const fill = async (dev) => {
  if (dev.getStoreValue(HISTORY_KEY) === FILL_VERSION) return null;
  let api = null;
  try {
    ({ api } = dev.homey.app);
  } catch {
    api = null;
  }
  if (!api) return { retry: true };
  api = InsightsHistory.tracked(api);
  await load(dev);
  const id = dev.getId();
  const series = {};
  for (const key of SRC) {
    const entries = await InsightsHistory.fetchHistory(api, InsightsHistory.deviceLogId(id, CAPS[key]), ['last7Days', 'last14Days']);
    series[key] = new Map(entries.filter((e) => !e.coarse).map((e) => [e.t, e.v]));
  }
  const today = dayOf(dev, Date.now());
  let hours = 0;
  const touched = new Set();
  [...series.grid.keys()].sort((a, b) => a - b).forEach((t) => {
    if (t + HOUR_MS > today.from) return;
    const day = dayOf(dev, t);
    const slot = slotFor(dev, day.year, day.doy);
    if (!slot || slot.log.src[slot.i] === LIVE) return;
    const key = `${day.year}-${day.doy}`;
    if (!touched.has(key)) {
      touched.add(key);
      PAIRS.forEach((p) => {
        slot.log[p][slot.i] = -1;
      });
    }
    const w = {};
    SRC.forEach((s) => {
      w[s] = series[s].has(t) ? series[s].get(t) : 0;
    });
    const pairs = split(w);
    if (pairs) {
      addTo(slot, pairs, 1, REBUILT);
      hours += 1;
    }
  });
  dev.flowPairsDay = null;
  const files = await FileStore.open(dev);
  files.set(KEY, dev[KEY]);
  await files.flush();
  if (api.failed) return { retry: true, failed: api.failed };
  await dev.setStoreValue(HISTORY_KEY, FILL_VERSION);
  return { days: touched.size, hours };
};

const start = async (dev) => {
  await load(dev).catch((err) => dev.error(err));
  if (dev[KEY] === undefined) dev[KEY] = null;
  if (dev.getStoreValue(HISTORY_KEY) === FILL_VERSION) return;
  const session = dev.sessionId;
  const run = (tries) => dev.homey.setTimeout(() => {
    if (dev.sessionId !== session || dev.isDestroyed) return;
    ContractYear.serial(() => fill(dev))
      .then((result) => {
        if (result) dev.log(`${KEY} from Insights:`, JSON.stringify(result));
        if (result && result.retry && tries < 3) run(tries + 1);
      })
      .catch((err) => dev.error(err));
  }, tries ? HOUR_MS : 6 * 60 * 1000 + Math.random() * 120000);
  run(0);
};

module.exports = {
  split, record, period, fill, start, SRC, DST,
};
