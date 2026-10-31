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

const TimeHelpers = require('./TimeHelpers');

class MeterHelpers {
  /**
   * The day a month starts: the start day, or the last day of a month without it (31: 30 April,
   * 28 or 29 February).
   * @param {number} startDay - 1-31
   * @param {number} year
   * @param {number} month - January is 0
   */
  static monthStartDay(startDay, year, month) {
    return Math.min(startDay, new Date(year, month + 1, 0).getDate());
  }

  /**
   * The local dates the current month and year started on, for a local date.
   * @param {Date} dateLocal
   * @param {number} startDay - 1-31
   * @param {number} startMonth - January is 0
   * @returns {{month: Date, year: Date}}
   */
  static periodStarts(dateLocal, startDay, startMonth) {
    const y = dateLocal.getFullYear();
    const m = dateLocal.getMonth();
    const start = (year, month) => new Date(year, month, MeterHelpers.monthStartDay(startDay, year, month));
    const month = dateLocal >= start(y, m) ? start(y, m) : start(m === 0 ? y - 1 : y, (m + 11) % 12);
    const year = dateLocal >= start(y, startMonth) ? start(y, startMonth) : start(y - 1, startMonth);
    return { month, year };
  }

  /**
   * Determine new periods based on current and last readings
   * @param {object} currentReading
   * @param {object} lastReadingHour
   * @param {object} lastReadingDay
   * @param {object} lastReadingMonth
   * @param {object} lastReadingYear
   * @param {number} startDay
   * @param {number} startMonth
   * @returns {object} { newHour, newDay, newMonth, newYear }
   */
  static getPeriods(currentReading, lastReadingHour, lastReadingDay, lastReadingMonth, lastReadingYear, startDay, startMonth) {
    const newHour = currentReading.hour !== lastReadingHour.hour;
    const newDay = (currentReading.day !== lastReadingDay.day);

    // A new month on the start day of this month, or once the period of this reading started after
    // the last month reading (also after being offline over a start day). The same for the year.
    const ym = (year, month) => year * 12 + month;
    const starts = MeterHelpers.periodStarts(new Date(currentReading.year, currentReading.month, currentReading.day), startDay, startMonth);
    const day = MeterHelpers.monthStartDay(startDay, currentReading.year, currentReading.month);
    const newMonth = (newDay && (currentReading.day === day))
      || ym(starts.month.getFullYear(), starts.month.getMonth()) > ym(lastReadingMonth.year, lastReadingMonth.month);

    const newYear = (newMonth && starts.month.getTime() === starts.year.getTime())
      || ym(starts.year.getFullYear(), starts.year.getMonth()) > ym(lastReadingYear.year, lastReadingYear.month);

    return {
      newHour, newDay, newMonth, newYear,
    };
  }

  /**
   * A new start date: the month and year go on from the last readings until their next start (no
   * reset now; repair offers to fix the totals). Returns the month and year readings to store.
   * @param {object} lastReadingMonth
   * @param {object} lastReadingYear
   * @param {Date} dateLocal
   */
  static keepPeriods(lastReadingMonth, lastReadingYear, dateLocal) {
    const now = { month: dateLocal.getMonth(), year: dateLocal.getFullYear() };
    return { month: { ...lastReadingMonth, ...now }, year: { ...lastReadingYear, ...now } };
  }

  /**
   * Create a reading object from a raw value and date
   * @param {number} value
   * @param {Date} date
   * @param {string} timeZone
   * @returns {object}
   */
  static getReadingObject(value, date, timeZone) {
    const dateLocal = TimeHelpers.toLocalDate(date, timeZone);
    return {
      hour: dateLocal.getHours(),
      day: dateLocal.getDate(),
      month: dateLocal.getMonth(),
      year: dateLocal.getFullYear(),
      meterValue: value,
      meterTm: date,
    };
  }

  /**
   * Calculate money based on readings and tariff
   * @param {object} currentMoney State of money object
   * @param {object} currentReading Current reading object
   * @param {number} tariff Current tariff
   * @param {number} [deltaMoneyOverride] delta to use instead of (meter delta x tariff), for a
   *   subclass settlement scheme; undefined/null: the default
   * @returns {object} New money object
   */
  static calculateMoney(currentMoney, currentReading, tariff, deltaMoneyOverride) {
    let deltaMoney = 0;
    if (typeof deltaMoneyOverride === 'number') {
      deltaMoney = deltaMoneyOverride;
    } else if (typeof currentMoney.meterValue === 'number' && typeof currentReading.meterValue === 'number' && typeof tariff === 'number') {
      deltaMoney = (currentReading.meterValue - currentMoney.meterValue) * tariff;
    }

    const newMoney = {
      day: MeterHelpers.safeAdd(currentMoney.day, deltaMoney),
      month: MeterHelpers.safeAdd(currentMoney.month, deltaMoney),
      year: MeterHelpers.safeAdd(currentMoney.year, deltaMoney),
      meterValue: currentReading.meterValue,
      lastDay: currentMoney.lastDay,
      lastMonth: currentMoney.lastMonth,
      lastYear: currentMoney.lastYear,
    };
    if (currentMoney.hour !== undefined) {
      newMoney.hour = MeterHelpers.safeAdd(currentMoney.hour, deltaMoney);
      newMoney.lastHour = currentMoney.lastHour;
    }
    return newMoney;
  }

  /**
   * Determine active tariff based on settings and available power data
   * @param {object} settings Device settings
   * @param {number|null} currentGridPower Central Homey Energy cumulative power (W)
   * @param {number} tariff Import tariff
   * @param {number} exportTariff Export tariff
   * @param {number} [deltaMeter] Difference between current and last meter reading
   * @returns {number} Active tariff
   */
  static getActiveTariff(settings, currentGridPower, tariff, exportTariff, deltaMeter) {
    const tariffType = settings?.tariff_type || 'dynamic';

    if (tariffType === 'import') return tariff;
    if (tariffType === 'export') return exportTariff;

    if (typeof deltaMeter === 'number' && deltaMeter < 0) return exportTariff;

    // dynamic
    if (typeof currentGridPower === 'number') {
      return currentGridPower < 0 ? exportTariff : tariff;
    }
    return tariff;
  }

  /**
   * A cumulative source meter (kWh charged or discharged) only goes up. A missing value or a lower
   * one is skipped: a brief dip and its recovery would be paid at different tariffs. A lower value
   * that lasts holdMs is a real reset: take it as the new base (rebase, without money).
   * @param {object|undefined} state - { value, lowerSince } from the previous call
   * @param {*} val - the reported value
   * @param {number} nowMs
   * @param {number} [holdMs]
   * @returns {{ state: object, use: boolean, rebase: boolean }}
   */
  static cumulativeReading(state, val, nowMs, holdMs = 15 * 60 * 1000) {
    const last = state && Number.isFinite(state.value) ? state.value : null;
    if (!Number.isFinite(val)) return { state, use: false, rebase: false };
    if (last === null || val >= last) return { state: { value: val, lowerSince: null }, use: true, rebase: false };
    const lowerSince = state && Number.isFinite(state.lowerSince) ? state.lowerSince : nowMs;
    if (nowMs - lowerSince >= holdMs) return { state: { value: val, lowerSince: null }, use: true, rebase: true };
    return { state: { value: last, lowerSince }, use: false, rebase: false };
  }

  /**
   * Add a delta to a running total, treating a not-yet-initialized/NaN base as 0.
   * @param {number} base
   * @param {number} delta
   * @returns {number}
   */
  static safeAdd(base, delta) {
    const b = (typeof base === 'number' && !Number.isNaN(base)) ? base : 0;
    return b + delta;
  }

  /**
   * Tariff for a delta that may span a price-interval boundary: when the tariff was only set at or
   * after the boundary, the PREVIOUS interval's tariff applies.
   * @param {object} tariffHistory { current, currentExport, previous, previousExport, currentTm }
   * @param {number} priceInterval minutes (15/30/45/60)
   * @param {Date|number} currentTm
   * @param {Date|number} lastTm
   * @param {{tariff: number, exportTariff: number}} [defaultTariff] when no boundary was crossed;
   *   defaults to tariffHistory.current/currentExport
   * @param {string} [timeZone] intervals follow local time (half-hour-offset zones)
   * @returns {{ tariff: number, exportTariff: number }}
   */
  static getPeriodTariff(tariffHistory, priceInterval, currentTm, lastTm, defaultTariff, timeZone) {
    let tariff = defaultTariff ? defaultTariff.tariff : tariffHistory.current;
    let exportTariff = tariff;
    if (defaultTariff) {
      exportTariff = defaultTariff.exportTariff;
    } else if (typeof tariffHistory.currentExport === 'number') {
      exportTariff = tariffHistory.currentExport;
    }

    const startOfInterval = (tm) => TimeHelpers.startOfLocalBlock(tm, priceInterval, timeZone);
    const startOfCurrent = startOfInterval(currentTm);
    const newPricePeriod = startOfCurrent > startOfInterval(lastTm);

    if (newPricePeriod && tariffHistory.currentTm) {
      const tariffSetTm = new Date(tariffHistory.currentTm).getTime();
      if (tariffSetTm >= startOfCurrent) {
        tariff = typeof tariffHistory.previous === 'number' ? tariffHistory.previous : tariff;
        exportTariff = typeof tariffHistory.previousExport === 'number' ? tariffHistory.previousExport : exportTariff;
      }
    }
    return { tariff, exportTariff };
  }

  /**
   * Start of the aligned block containing tm.
   * @param {Date|number} tm
   * @param {number} minutes
   * @param {string} [timeZone] blocks follow local time (see TimeHelpers.startOfLocalBlock())
   * @returns {number} epoch ms of the block start
   */
  static startOfBlock(tm, minutes, timeZone) {
    return TimeHelpers.startOfLocalBlock(tm, minutes, timeZone);
  }
}

module.exports = MeterHelpers;
