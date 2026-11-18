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

// The battery day log for widgets/battery: per local day of this year the kWh charged and discharged
// and the money, logged at midnight; the days before rebuilt once from Insights. Per month the money
// (exact from Insights). { v, year, charged, discharged, money, est (1: estimated) [366], mMoney [12],
// prev (the last 31 days of the year before) }; -1: unknown. Plain number arrays, ~12 KB.
const FileStore = require('./FileStore');
const SolarHistory = require('./SolarHistory');
const TimeHelpers = require('./TimeHelpers');

const KEY = 'batteryDayLog';
const VERSION = 1;
const HISTORY_KEY = 'batteryDayLogFilled';
const FIELDS = ['charged', 'discharged', 'money', 'est'];
const MAX_DAY_KWH = 500; // above: a meter jump

const doyOf = (y, m, d) => Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);

const load = async (dev) => {
  if (dev.batteryDayLog === undefined) dev.batteryDayLog = (await FileStore.open(dev, [KEY])).get(KEY) || null;
  return dev.batteryDayLog;
};

const logFor = (dev, year) => {
  const cur = dev.batteryDayLog;
  if (!cur || cur.v !== VERSION || cur.year !== year) {
    const old = cur && cur.v === VERSION && cur.year === year - 1 ? cur : null;
    const days = doyOf(year, 0, 1) - doyOf(year - 1, 0, 1) || 365;
    const empty = () => new Array(366).fill(-1);
    const prev = old ? { year: year - 1, from: days - 31 } : null;
    if (prev) {
      FIELDS.forEach((f) => {
        prev[f] = old[f].slice(days - 31, days);
      });
    }
    dev.batteryDayLog = {
      v: VERSION, year, mMoney: new Array(12).fill(-1), prev, ...Object.fromEntries(FIELDS.map((f) => [f, empty()])),
    };
  }
  return dev.batteryDayLog;
};

// A logged day { charged, discharged, money (null unknown), est }, null without.
const loggedDay = (dev, year, doy) => {
  const main = dev.batteryDayLog;
  if (!main || main.v !== VERSION) return null;
  let log = null;
  let i = doy;
  if (main.year === year) log = main;
  else if (main.prev && main.prev.year === year) {
    log = main.prev;
    i = doy - log.from;
  }
  if (!log || !(log.charged[i] >= 0) || !(log.discharged[i] >= 0)) return null;
  return {
    charged: log.charged[i], discharged: log.discharged[i], money: log.money[i] > -1 || log.money[i] < -1 ? log.money[i] : null, est: log.est[i] === 1,
  };
};

const round = (v, f) => Math.round(v * f) / f;

// The day that ended at the last midnight, from the 'last day' meters (after their roll).
const logYesterday = async (dev) => {
  const tz = dev.timeZone || dev.homey.clock.getTimezone();
  const midnight = TimeHelpers.getLocalMidnightUTC(new Date(), tz).getTime();
  const date = TimeHelpers.toLocalDate(new Date(midnight - 1), tz);
  const cap = (id) => (dev.hasCapability(id) && typeof dev.getCapabilityValue(id) === 'number' ? dev.getCapabilityValue(id) : null);
  const charged = cap('meter_kwh_last_day.charged');
  const discharged = cap('meter_kwh_last_day.discharged');
  if (charged === null || discharged === null) return;
  await load(dev);
  const log = logFor(dev, date.getFullYear());
  const doy = doyOf(date.getFullYear(), date.getMonth(), date.getDate());
  const money = dev.meterMoney && typeof dev.meterMoney.lastDay === 'number' ? dev.meterMoney.lastDay : null;
  log.charged[doy] = round(Math.max(0, charged), 1000);
  log.discharged[doy] = round(Math.max(0, discharged), 1000);
  // Money may be below -1 (a loss): unknown is exactly -1.
  log.money[doy] = money === null ? -1 : round(money === -1 ? -1.0001 : money, 10000);
  log.est[doy] = 0;
  (await FileStore.open(dev)).set(KEY, log);
};

const historyPending = (dev) => dev.getStoreValue(HISTORY_KEY) !== VERSION;

// The days and months of this year before the log, once: kWh from the device's meters (exact the last
// 14 days, else between 6-hour points: estimated), money exact the last 14 days, per month exact.
const fill = async (dev) => {
  if (!historyPending(dev)) return null;
  let api = null;
  try {
    ({ api } = dev.homey.app);
  } catch {
    api = null;
  }
  if (!api) return null;
  const tz = dev.timeZone || dev.homey.clock.getTimezone();
  const year = TimeHelpers.toLocalDate(new Date(), tz).getFullYear();
  const { days, points } = SolarHistory.bounds(year, tz);
  const index = new Map(points.map((t, i) => [t, i]));
  await load(dev);
  const log = logFor(dev, year);
  const id = dev.getId();
  const exact = {
    charged: await SolarHistory.dayEndValues(api, id, 'meter_kwh_this_day.charged', days),
    discharged: await SolarHistory.dayEndValues(api, id, 'meter_kwh_this_day.discharged', days),
    money: await SolarHistory.dayEndValues(api, id, 'meter_money_this_day', days),
  };
  for (const [field, cap] of [['charged', 'meter_kwh_charging'], ['discharged', 'meter_kwh_discharging']]) {
    let values = await SolarHistory.meterValues(api, id, [cap], points);
    days.forEach(({ doy, ms, next }) => {
      if (log[field][doy] >= 0 && log.est[doy] === 0) return;
      if (exact[field].has(doy)) {
        log[field][doy] = round(Math.max(0, exact[field].get(doy)), 1000);
        return;
      }
      const a = values ? values[index.get(ms)] : null;
      const b = values ? values[index.get(next)] : null;
      if (typeof a === 'number' && typeof b === 'number' && b - a >= -0.05 && b - a <= MAX_DAY_KWH) {
        log[field][doy] = round(Math.max(0, b - a), 1000);
      }
    });
    values = null;
  }
  days.forEach(({ doy }) => {
    if (log.est[doy] === 0) return;
    const known = exact.charged.has(doy) && exact.discharged.has(doy) && exact.money.has(doy);
    if (exact.money.has(doy)) log.money[doy] = round(exact.money.get(doy) === -1 ? -1.0001 : exact.money.get(doy), 10000);
    if (log.charged[doy] >= 0) log.est[doy] = known ? 0 : 1;
  });
  const mMoney = await SolarHistory.monthEndValues(api, id, 'meter_money_this_month', year, tz);
  mMoney.forEach((v, m) => {
    if (typeof v === 'number') log.mMoney[m] = v;
  });
  const files = await FileStore.open(dev);
  files.set(KEY, log);
  await files.flush();
  await dev.setStoreValue(HISTORY_KEY, VERSION);
  return { days: log.charged.filter((v) => v >= 0).length, money: log.money.filter((v) => v !== -1).length };
};

module.exports = {
  load, loggedDay, logYesterday, fill, historyPending, doyOf,
};
