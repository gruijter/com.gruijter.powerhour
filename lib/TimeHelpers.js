/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

module.exports = {
  getUTCPeriods(timeZone, driverId) {
    const now = new Date();
    now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone }));
    const homeyOffset = nowLocal - now;

    // Helper to find UTC time for a local time (shifted Date)
    // This handles DST transitions by estimating UTC, checking the local time of that estimate, and adjusting the diff.
    const getUTC = (localDate) => {
      const estimatedUTC = new Date(localDate.getTime() - homeyOffset);
      const checkLocal = new Date(estimatedUTC.toLocaleString('en-US', { timeZone }));
      const diff = localDate.getTime() - checkLocal.getTime();
      return new Date(estimatedUTC.getTime() + diff);
    };

    // this quarter start in UTC
    const quarterStartLocal = new Date(nowLocal);
    quarterStartLocal.setMinutes(Math.floor(nowLocal.getMinutes() / 15) * 15);
    quarterStartLocal.setSeconds(0);
    const quarterStart = getUTC(quarterStartLocal);

    // this hour start in UTC
    const hourStartLocal = new Date(nowLocal);
    hourStartLocal.setMinutes(0);
    hourStartLocal.setSeconds(0);
    const hourStart = getUTC(hourStartLocal);

    // periodStart depending on driver
    const periodStart = driverId === 'dap15' ? quarterStart : hourStart;
    // this day start in UTC
    const todayStartLocal = new Date(nowLocal);
    todayStartLocal.setHours(0, 0, 0, 0);
    const todayStart = getUTC(todayStartLocal);

    // yesterday start in UTC
    const yesterdayStartLocal = new Date(todayStartLocal);
    yesterdayStartLocal.setDate(yesterdayStartLocal.getDate() - 1);
    const yesterdayStart = getUTC(yesterdayStartLocal);

    // tomorrow start in UTC
    const tomorrowStartLocal = new Date(todayStartLocal);
    tomorrowStartLocal.setDate(tomorrowStartLocal.getDate() + 1);
    const tomorrowStart = getUTC(tomorrowStartLocal);

    // tomorrow end in UTC
    const tomorrowEndLocal = new Date(tomorrowStartLocal);
    tomorrowEndLocal.setDate(tomorrowEndLocal.getDate() + 1);
    const tomorrowEnd = getUTC(tomorrowEndLocal);

    // get the present hour (0 - 23) and quarter (0 - 95)
    const H0 = nowLocal.getHours();
    const Q0 = (H0 * 4) + Math.floor(nowLocal.getMinutes() / 15);
    // get day of month (1 - 31) and month of year (0 - 11);
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
    // Pass 1: find local time at d and approximate the UTC offset
    const localNow = new Date(d.toLocaleString('en-US', { timeZone }));
    const approxOffset = localNow.getTime() - d.getTime();
    // Build a local Date set to 00:00:00 for the same local calendar date
    const localMidnight = new Date(localNow);
    localMidnight.setHours(0, 0, 0, 0);
    // Subtract approximate offset → candidate UTC midnight
    const candidateUTC = new Date(localMidnight.getTime() - approxOffset);
    // Pass 2: verify actual local time at that candidate and apply residual DST correction
    const checkLocal = new Date(candidateUTC.toLocaleString('en-US', { timeZone }));
    const diff = localMidnight.getTime() - checkLocal.getTime();
    return new Date(candidateUTC.getTime() + diff);
  },
};
