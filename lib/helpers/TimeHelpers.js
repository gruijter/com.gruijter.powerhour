/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

// One Intl formatter per timezone, reused. Creating the formatting data is the expensive part of
// Date.prototype.toLocaleString(), which does it again on every call.
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

// Wall-clock time in `timeZone` as a Date whose local fields (getHours(), getDay(), ...) hold it.
// Drop-in for `new Date(date.toLocaleString('en-US', { timeZone }))`, including its whole-second
// precision, but without rebuilding the formatter on every call.
const toLocalDate = (date, timeZone) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date(NaN);
  const p = {};
  getLocalFormatter(timeZone).formatToParts(d).forEach((part) => {
    p[part.type] = part.value;
  });
  return new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
};

// Start (epoch ms) of the local-time block of `minutes` holding tm, e.g. the local hour for 60.
// UTC offsets are whole multiples of 15 minutes, so blocks that divide 15 minutes line up in UTC
// too and skip the Intl call; longer blocks (30/60) need the offset: in a half-hour zone (India,
// Adelaide, Newfoundland) the local hour starts at UTC :30.
const startOfLocalBlock = (tm, minutes, timeZone) => {
  const ms = tm instanceof Date ? tm.getTime() : new Date(tm).getTime();
  const blockMs = minutes * 60 * 1000;
  if (Number.isNaN(ms) || !(blockMs > 0)) return ms;
  let offsetMs = 0;
  if (15 % minutes !== 0) {
    const secMs = ms - (((ms % 1000) + 1000) % 1000); // toLocalDate() drops sub-seconds
    offsetMs = toLocalDate(new Date(secMs), timeZone).getTime() - secMs;
  }
  const localMs = ms + offsetMs;
  return ms - (((localMs % blockMs) + blockMs) % blockMs);
};

// A list per slot (prices, forecast flags) as a list per finer slot, e.g. hourly prices for a
// plan in quarters. Both lists start at the slot holding now: toStartMs >= fromStartMs.
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

// A decimal hour (7.75 = 07:45) from a flow number arg; a comma may be the decimal separator.
const parseHours = (value) => Number(typeof value === 'string' ? value.replace(',', '.') : value);

// A clock time from a flow text or number arg, as decimal hours 0-24, or null: with a colon a clock
// time ('7:30', '07:30'), else decimal hours (7.5 or '7,5' = 07:30).
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

// Decimal hours as 'HH:MM' (rounded to the minute).
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

  // interval: the price interval in minutes (15, 30 or 60), for periodStart.
  getUTCPeriods(timeZone, interval = 60) {
    const now = new Date();
    now.setMilliseconds(0); // toLocalDate() drops sub-second precision; zero it so homeyOffset is an exact whole-second diff
    const nowLocal = toLocalDate(now, timeZone);
    const homeyOffset = nowLocal - now;

    // Helper to find UTC time for a local time (shifted Date)
    // This handles DST transitions by estimating UTC, checking the local time of that estimate, and adjusting the diff.
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

    // present hour (0-23) and quarter (0-95)
    const H0 = nowLocal.getHours();
    const Q0 = (H0 * 4) + Math.floor(nowLocal.getMinutes() / 15);
    // day of month (1-31) and month of year (0-11, JS Date convention)
    const monthNumber = nowLocal.getMonth();
    const dayNumber = nowLocal.getDate();
    return {
      now, nowLocal, homeyOffset, H0, Q0, periodStart, quarterStart, halfStart, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd, dayNumber, monthNumber,
    };
  },

  /**
   * Returns the UTC Date corresponding to local midnight (00:00:00 local time)
   * for the local date containing the given UTC Date d.
   *
   * Uses a two-pass correction so it stays correct across DST transitions —
   * the UTC offset at midnight may differ from the offset at time d.
   *
   * @param {Date} d        - Any UTC Date within the local day of interest
   * @param {string} timeZone - IANA timezone string (e.g. 'Europe/Amsterdam')
   * @returns {Date}        - UTC Date representing local midnight
   */
  getLocalMidnightUTC(d, timeZone) {
    // toLocalDate() drops sub-seconds: strip d's own, or they leak into the returned midnight.
    const dSec = new Date(d.getTime() - (d.getTime() % 1000));
    // Pass 1: find local time at d and approximate the UTC offset
    const localNow = toLocalDate(dSec, timeZone);
    const approxOffset = localNow.getTime() - dSec.getTime();
    const localMidnight = new Date(localNow);
    localMidnight.setHours(0, 0, 0, 0);
    // Subtract approximate offset → candidate UTC midnight
    const candidateUTC = new Date(localMidnight.getTime() - approxOffset);
    // Pass 2: verify actual local time at that candidate and apply residual DST correction
    const checkLocal = toLocalDate(candidateUTC, timeZone);
    const diff = localMidnight.getTime() - checkLocal.getTime();
    return new Date(candidateUTC.getTime() + diff);
  },

  /**
   * Epoch ms of local clock time fh (fractional hours, 0-24) on the local day starting at
   * midnightMs (from getLocalMidnightUTC). DST-safe: on a DST day the offset at fh differs from
   * the one at midnight.
   */
  localTimeMs(midnightMs, fh, timeZone) {
    // Wall clock of ms as if it were UTC: no process-time-zone Date arithmetic.
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
    // Twice: once for a DST change between midnight and fh, once more inside a skipped hour.
    for (let i = 0; i < 2; i += 1) t += (midnightWall + offsetMs) - (wall(t) - (t % 1000));
    return t;
  },

  /** UTC Date of local clock time hhmm ('HH:MM') on the local day starting at dayStartUTC. */
  localTimeToUTC(dayStartUTC, hhmm, timeZone) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(module.exports.localTimeMs(dayStartUTC.getTime(), h + (m / 60), timeZone));
  },
};
