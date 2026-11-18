/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const localFormatters = new Map();
const getLocalFormatter = (timeZone) => {
  const key = timeZone || '';
  let fmt = localFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    localFormatters.set(key, fmt);
  }
  return fmt;
};

const QUARTER_MS = 15 * 60 * 1000;
const MAX_OFFSETS = 4096;
const localOffsets = new Map();

const localOffsetMs = (secMs, timeZone) => {
  const key = `${timeZone}|${Math.floor(secMs / QUARTER_MS)}`;
  let offset = localOffsets.get(key);
  if (offset === undefined) {
    const p = {};
    getLocalFormatter(timeZone).formatToParts(new Date(secMs)).forEach((part) => {
      p[part.type] = part.value;
    });
    offset = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - secMs;
    if (localOffsets.size >= MAX_OFFSETS) localOffsets.clear();
    localOffsets.set(key, offset);
  }
  return offset;
};

const toLocalDate = (date, timeZone) => {
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(ms)) return new Date(NaN);
  const secMs = ms - (((ms % 1000) + 1000) % 1000);
  const w = new Date(secMs + localOffsetMs(secMs, timeZone));
  return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());
};

const startOfLocalBlock = (tm, minutes, timeZone) => {
  const ms = tm instanceof Date ? tm.getTime() : new Date(tm).getTime();
  const blockMs = minutes * 60 * 1000;
  if (Number.isNaN(ms) || !(blockMs > 0)) return ms;
  let offsetMs = 0;
  if (15 % minutes !== 0) {
    const secMs = ms - (((ms % 1000) + 1000) % 1000);
    offsetMs = toLocalDate(new Date(secMs), timeZone).getTime() - secMs;
  }
  const localMs = ms + offsetMs;
  return ms - (((localMs % blockMs) + blockMs) % blockMs);
};

const toFinerSlots = (list, fromStartMs, fromMinutes, toStartMs, toMinutes) => {
  if (!Array.isArray(list)) return list;
  const out = [];
  for (let t = toStartMs; ; t += toMinutes * 60 * 1000) {
    const i = Math.floor((t - fromStartMs) / (fromMinutes * 60 * 1000));
    if (i >= list.length) break;
    out.push(list[i]);
  }
  return out;
};

const parseHours = (value) => Number(typeof value === 'string' ? value.replace(',', '.') : value);

const parseClock = (value) => {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (str === '') return null;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (m > 59 || h > 24 || (h === 24 && m > 0)) return null;
    return h + (m / 60);
  }
  if (!/^\d{1,2}([.,]\d+)?$/.test(str)) return null;
  const hours = parseHours(str);
  return (Number.isFinite(hours) && hours >= 0 && hours <= 24) ? hours : null;
};

const formatClock = (hours) => {
  const total = Math.round(hours * 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

module.exports = {
  toLocalDate,
  parseHours,
  parseClock,
  formatClock,
  startOfLocalBlock,
  toFinerSlots,

  getUTCPeriods(timeZone, interval = 60) {
    const now = new Date();
    now.setMilliseconds(0);
    const nowLocal = toLocalDate(now, timeZone);
    const homeyOffset = nowLocal - now;

    const getUTC = (localDate) => {
      const estimatedUTC = new Date(localDate.getTime() - homeyOffset);
      const checkLocal = toLocalDate(estimatedUTC, timeZone);
      const diff = localDate.getTime() - checkLocal.getTime();
      return new Date(estimatedUTC.getTime() + diff);
    };

    const quarterStartLocal = new Date(nowLocal);
    quarterStartLocal.setMinutes(Math.floor(nowLocal.getMinutes() / 15) * 15);
    quarterStartLocal.setSeconds(0);
    const quarterStart = getUTC(quarterStartLocal);

    const halfStartLocal = new Date(nowLocal);
    halfStartLocal.setMinutes(Math.floor(nowLocal.getMinutes() / 30) * 30);
    halfStartLocal.setSeconds(0);
    const halfStart = getUTC(halfStartLocal);

    const hourStartLocal = new Date(nowLocal);
    hourStartLocal.setMinutes(0);
    hourStartLocal.setSeconds(0);
    const hourStart = getUTC(hourStartLocal);

    let periodStart = hourStart;
    if (interval === 15) periodStart = quarterStart;
    if (interval === 30) periodStart = halfStart;
    const todayStartLocal = new Date(nowLocal);
    todayStartLocal.setHours(0, 0, 0, 0);
    const todayStart = getUTC(todayStartLocal);

    const yesterdayStartLocal = new Date(todayStartLocal);
    yesterdayStartLocal.setDate(yesterdayStartLocal.getDate() - 1);
    const yesterdayStart = getUTC(yesterdayStartLocal);

    const tomorrowStartLocal = new Date(todayStartLocal);
    tomorrowStartLocal.setDate(tomorrowStartLocal.getDate() + 1);
    const tomorrowStart = getUTC(tomorrowStartLocal);

    const tomorrowEndLocal = new Date(tomorrowStartLocal);
    tomorrowEndLocal.setDate(tomorrowEndLocal.getDate() + 1);
    const tomorrowEnd = getUTC(tomorrowEndLocal);

    const H0 = nowLocal.getHours();
    const Q0 = (H0 * 4) + Math.floor(nowLocal.getMinutes() / 15);
    const monthNumber = nowLocal.getMonth();
    const dayNumber = nowLocal.getDate();
    return {
      now, nowLocal, homeyOffset, H0, Q0, periodStart, quarterStart, halfStart, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd, dayNumber, monthNumber,
    };
  },

  getLocalMidnightUTC(d, timeZone) {
    const dSec = new Date(d.getTime() - (d.getTime() % 1000));
    const localNow = toLocalDate(dSec, timeZone);
    const approxOffset = localNow.getTime() - dSec.getTime();
    const localMidnight = new Date(localNow);
    localMidnight.setHours(0, 0, 0, 0);
    const candidateUTC = new Date(localMidnight.getTime() - approxOffset);
    const checkLocal = toLocalDate(candidateUTC, timeZone);
    const diff = localMidnight.getTime() - checkLocal.getTime();
    return new Date(candidateUTC.getTime() + diff);
  },

  localTimeMs(midnightMs, fh, timeZone) {
    const wall = (ms) => {
      const p = {};
      getLocalFormatter(timeZone).formatToParts(new Date(ms)).forEach((part) => {
        p[part.type] = Number(part.value);
      });
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    };
    const offsetMs = Math.round(fh * 3600) * 1000;
    const midnightWall = wall(midnightMs);
    let t = midnightMs + offsetMs;
    for (let i = 0; i < 2; i += 1) t += (midnightWall + offsetMs) - (wall(t) - (t % 1000));
    return t;
  },

  localTimeToUTC(dayStartUTC, hhmm, timeZone) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(module.exports.localTimeMs(dayStartUTC.getTime(), h + (m / 60), timeZone));
  },

  nextLocalTime(hhmm, timeZone, now = Date.now()) {
    const today = module.exports.getLocalMidnightUTC(new Date(now), timeZone);
    const at = module.exports.localTimeToUTC(today, hhmm, timeZone).getTime();
    if (at > now) return at;
    const tomorrow = module.exports.getLocalMidnightUTC(new Date(today.getTime() + 26 * 60 * 60 * 1000), timeZone);
    return module.exports.localTimeToUTC(tomorrow, hhmm, timeZone).getTime();
  },
};
