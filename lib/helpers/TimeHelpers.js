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

module.exports = {
  toLocalDate,
  startOfLocalBlock,

  getUTCPeriods(timeZone, driverId) {
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

    const hourStartLocal = new Date(nowLocal);
    hourStartLocal.setMinutes(0);
    hourStartLocal.setSeconds(0);
    const hourStart = getUTC(hourStartLocal);

    const periodStart = driverId === 'dap15' ? quarterStart : hourStart;
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
      now, nowLocal, homeyOffset, H0, Q0, periodStart, quarterStart, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd, dayNumber, monthNumber,
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
    // toLocalDate() drops sub-second precision, so it always yields a whole-second Date.
    // Strip d's own sub-second component first (without mutating the caller's Date) - otherwise
    // that residue leaks into approxOffset/diff below and ends up baked into the returned
    // "midnight" timestamp (e.g. ...812 instead of ...000), even though real-world UTC offsets
    // are always a whole number of minutes and midnight should land on an exact second.
    const dSec = new Date(d.getTime() - (d.getTime() % 1000));
    // Pass 1: find local time at d and approximate the UTC offset
    const localNow = toLocalDate(dSec, timeZone);
    const approxOffset = localNow.getTime() - dSec.getTime();
    // Build a local Date set to 00:00:00 for the same local calendar date
    const localMidnight = new Date(localNow);
    localMidnight.setHours(0, 0, 0, 0);
    // Subtract approximate offset → candidate UTC midnight
    const candidateUTC = new Date(localMidnight.getTime() - approxOffset);
    // Pass 2: verify actual local time at that candidate and apply residual DST correction
    const checkLocal = toLocalDate(candidateUTC, timeZone);
    const diff = localMidnight.getTime() - checkLocal.getTime();
    return new Date(candidateUTC.getTime() + diff);
  },
};
