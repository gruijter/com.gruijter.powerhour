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
const FileStore = require('./FileStore');
const InsightsHistory = require('./InsightsHistory');
const SolarHistory = require('./SolarHistory');
const TimeHelpers = require('./TimeHelpers');

const VERSION = 1;
const MAX_DAY_KWH = 500;
const SPAN_TOLERANCE_MS = 3600000;

const spanExact = (startTm, dayStartMs) => Math.abs(new Date(startTm).getTime() - dayStartMs) <= SPAN_TOLERANCE_MS;

const doyOf = (y, m, d) => Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);
const daysIn = (year) => doyOf(year, 11, 31) + 1;
const round = (v, f) => Math.round(v * f) / f;
const RETRY_MS = 60 * 60 * 1000;
const RETRIES = 3;

const newYearLog = (v, year, fields, monthFields, old) => {
  const keep = old && old.v === v && old.year === year - 1 ? old : null;
  const days = daysIn(year - 1);
  const prev = keep ? { year: year - 1, from: days - 31 } : null;
  if (prev) {
    fields.forEach((f) => {
      prev[f] = keep[f].slice(days - 31, days);
    });
  }
  return {
    v,
    year,
    ...Object.fromEntries(fields.map((f) => [f, new Array(366).fill(-1)])),
    ...Object.fromEntries(monthFields.map((f) => [f, new Array(12).fill(-1)])),
    prev,
  };
};

const daySlot = (main, v, year, doy) => {
  if (!main || main.v !== v) return null;
  if (main.year === year) return { log: main, i: doy };
  if (main.prev && main.prev.year === year && doy >= main.prev.from) return { log: main.prev, i: doy - main.prev.from };
  return null;
};

const yearLog = (main, v, year, fields, monthFields) => {
  if (main && main.v === v && main.year > year) return null;
  if (!main || main.v !== v || main.year !== year) return newYearLog(v, year, fields, monthFields, main);
  return main;
};

const create = ({
  key, historyKey, fillVersion = VERSION, fields, lastDay, thisDay, meters, active = () => true,
}) => {
  const FIELDS = [...fields, 'money', 'est'];
  const [a, b] = fields;

  const load = async (dev) => {
    if (dev[key] === undefined) dev[key] = (await FileStore.open(dev, [key])).get(key) || null;
    return dev[key];
  };

  const logFor = (dev, year) => {
    const log = yearLog(dev[key], VERSION, year, FIELDS, ['mMoney']);
    if (log) dev[key] = log;
    return log;
  };

  const loggedDay = (dev, year, doy) => {
    const slot = daySlot(dev[key], VERSION, year, doy);
    if (!slot) return null;
    const { log, i } = slot;
    if (!(log[a][i] >= 0) || !(log[b][i] >= 0)) return null;
    return {
      [a]: log[a][i], [b]: log[b][i], money: log.money[i] > -1 || log.money[i] < -1 ? log.money[i] : null, est: log.est[i] === 1,
    };
  };

  const monthMoney = (dev, year, m) => {
    const log = dev[key];
    return log && log.v === VERSION && log.year === year && log.mMoney[m] !== -1 ? log.mMoney[m] : null;
  };

  const logYesterday = async (dev) => {
    const tz = dev.timeZone || dev.homey.clock.getTimezone();
    const midnight = TimeHelpers.getLocalMidnightUTC(new Date(), tz).getTime();
    const date = TimeHelpers.toLocalDate(new Date(midnight - 1), tz);
    const cap = (id) => (dev.hasCapability(id) && typeof dev.getCapabilityValue(id) === 'number' ? dev.getCapabilityValue(id) : null);
    const caps = typeof lastDay === 'function' ? lastDay(dev) : lastDay;
    const va = active(dev, a) ? cap(caps[a]) : 0;
    const vb = active(dev, b) ? cap(caps[b]) : 0;
    if (va === null || vb === null) return;
    await load(dev);
    const year = date.getFullYear();
    logFor(dev, year);
    const slot = daySlot(dev[key], VERSION, year, doyOf(year, date.getMonth(), date.getDate()));
    if (!slot) return;
    const { log, i } = slot;
    const money = dev.meterMoney && typeof dev.meterMoney.lastDay === 'number' ? dev.meterMoney.lastDay : null;
    log[a][i] = round(Math.max(0, va), 1000);
    log[b][i] = round(Math.max(0, vb), 1000);
    log.money[i] = money === null ? -1 : round(money === -1 ? -1.0001 : money, 10000);
    log.est[i] = spanExact(dev.endedDayStartTm, TimeHelpers.getLocalMidnightUTC(new Date(midnight - 1), tz).getTime()) ? 0 : 1;
    (await FileStore.open(dev)).set(key, dev[key]);
  };

  const historyPending = (dev) => dev.getStoreValue(historyKey) !== fillVersion;

  const fill = async (dev) => {
    if (!historyPending(dev)) return null;
    let api = null;
    try {
      ({ api } = dev.homey.app);
    } catch {
      api = null;
    }
    if (!api) return { retry: true };
    api = InsightsHistory.tracked(api);
    const tz = dev.timeZone || dev.homey.clock.getTimezone();
    const year = TimeHelpers.toLocalDate(new Date(), tz).getFullYear();
    const { days, points } = SolarHistory.bounds(year, tz);
    await load(dev);
    const log = logFor(dev, year);
    const id = dev.getId();
    const zeros = new Map(days.map(({ doy }) => [doy, 0]));
    const exact = { money: await SolarHistory.dayEndValues(api, id, 'meter_money_this_day', days, { lastCap: 'meter_money_last_day' }) };
    const dayCaps = typeof thisDay === 'function' ? thisDay(dev) : thisDay;
    const lastCaps = typeof lastDay === 'function' ? lastDay(dev) : lastDay;
    for (const field of fields) {
      exact[field] = active(dev, field)
        ? await SolarHistory.dayEndValues(api, id, dayCaps[field], days, { lastCap: lastCaps[field], monotonic: true }) : zeros;
    }
    fields.filter((f) => !active(dev, f)).forEach((f) => days.forEach(({ doy }) => {
      log[f][doy] = 0;
    }));
    for (const field of fields.filter((f) => active(dev, f))) {
      let deltas = SolarHistory.dayDeltas(await meters(api, dev, field, points), days, points, MAX_DAY_KWH);
      days.forEach(({ doy }) => {
        if (log[field][doy] >= 0 && log.est[doy] === 0) return;
        if (exact[field].has(doy)) log[field][doy] = round(Math.max(0, exact[field].get(doy)), 1000);
        else if (deltas.has(doy)) log[field][doy] = deltas.get(doy).kwh;
      });
      deltas = null;
    }
    days.forEach(({ doy }) => {
      if (log.est[doy] === 0) return;
      const known = exact[a].has(doy) && exact[b].has(doy) && exact.money.has(doy);
      if (exact.money.has(doy)) log.money[doy] = round(exact.money.get(doy) === -1 ? -1.0001 : exact.money.get(doy), 10000);
      if (log[a][doy] >= 0) log.est[doy] = known ? 0 : 1;
    });
    const mMoney = await SolarHistory.monthEndValues(api, id, 'meter_money_this_month', year, tz, { lastCap: 'meter_money_last_month' });
    mMoney.forEach((v, m) => {
      if (typeof v === 'number') log.mMoney[m] = v;
    });
    const files = await FileStore.open(dev);
    files.set(key, log);
    await files.flush();
    if (api.failed) return { retry: true, failed: api.failed };
    await dev.setStoreValue(historyKey, fillVersion);
    return { days: log[a].filter((v) => v >= 0).length, money: log.money.filter((v) => v !== -1).length };
  };

  const start = async (dev) => {
    await load(dev).catch((err) => dev.error(err));
    if (!historyPending(dev)) return;
    const session = dev.sessionId;
    const run = (tries) => dev.homey.setTimeout(() => {
      if (dev.sessionId !== session || dev.isDestroyed) return;
      ContractYear.serial(() => fill(dev))
        .then((result) => {
          if (result) dev.log(`${key} from Insights:`, JSON.stringify(result));
          if (result && result.retry && tries < RETRIES) run(tries + 1);
        })
        .catch((err) => dev.error(err));
    }, tries ? RETRY_MS : 5 * 60 * 1000 + Math.random() * 120000);
    run(0);
  };

  return {
    load, start, loggedDay, monthMoney, logYesterday, fill, historyPending, doyOf,
  };
};

module.exports = {
  create, doyOf, daysIn, yearLog, daySlot, spanExact,
};
