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

class MeterHelpers {
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

    // Check if a new day has started
    const newDay = (currentReading.day !== lastReadingDay.day);

    // Check if a new month has started
    // Logic: It is a new month if it is a new day AND current day matches startDay
    // OR if we are past startDay and the month has changed relative to last reading
    const newMonth = (newDay && (currentReading.day === startDay))
      || ((currentReading.day >= startDay) && (currentReading.month > lastReadingMonth.month))
      || ((currentReading.day >= startDay) && (currentReading.year > lastReadingMonth.year)); // Handle year wrap for month change

    // Check if a new year has started
    const newYear = (newMonth && (currentReading.month === startMonth))
      || ((currentReading.month >= startMonth) && (currentReading.year > lastReadingYear.year));

    return {
      newHour, newDay, newMonth, newYear,
    };
  }

  /**
   * Create a reading object from a raw value and date
   * @param {number} value
   * @param {Date} date
   * @param {string} timeZone
   * @returns {object}
   */
  static getReadingObject(value, date, timeZone) {
    const dateLocal = new Date(date.toLocaleString('en-US', { timeZone }));
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
   * @returns {object} New money object
   */
  static calculateMoney(currentMoney, currentReading, tariff) {
    let deltaMoney = 0;
    if (typeof currentMoney.meterValue === 'number' && typeof currentReading.meterValue === 'number' && typeof tariff === 'number') {
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
   * Pick the tariff that applies to a delta which may span a price-interval boundary
   * (e.g. 15/30/60 min DAP slots): if the elapsed window crossed into a new interval, and
   * the currently-active tariff was only set at/after that boundary, the delta should be
   * priced at the PREVIOUS interval's tariff, not the new one. Same shape as the
   * newPricePeriod logic in generic_sum_device.js#updateMoney(), generalized so callers
   * that keep their own separate tariff-history bookkeeping (e.g. a parallel money
   * calculation) don't need their own copy.
   * @param {object} tariffHistory { current, currentExport, previous, previousExport, currentTm }
   * @param {number} priceInterval Interval length in minutes (15/30/45/60)
   * @param {Date|number} currentTm Timestamp of the reading/tick being priced
   * @param {Date|number} lastTm Timestamp of the previous reading/tick
   * @param {{tariff: number, exportTariff: number}} [defaultTariff] Tariff to use when no
   *   boundary was crossed, for callers whose "live" tariff isn't tariffHistory.current itself
   *   (e.g. a driver reading a separate live price array that tariffHistory just mirrors).
   *   Defaults to tariffHistory.current/currentExport.
   * @returns {{ tariff: number, exportTariff: number }}
   */
  static getPeriodTariff(tariffHistory, priceInterval, currentTm, lastTm, defaultTariff) {
    let tariff = defaultTariff ? defaultTariff.tariff : tariffHistory.current;
    let exportTariff = tariff;
    if (defaultTariff) {
      exportTariff = defaultTariff.exportTariff;
    } else if (typeof tariffHistory.currentExport === 'number') {
      exportTariff = tariffHistory.currentExport;
    }

    const startOfInterval = (tm) => {
      const d = new Date(tm);
      d.setUTCMinutes(Math.floor(d.getUTCMinutes() / priceInterval) * priceInterval, 0, 0);
      return d.getTime();
    };
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
   * Start of the aligned block containing tm, given a block size in minutes. Factored out
   * for reuse by callers that need block alignment outside getPeriodTariff's own
   * price-interval bookkeeping (e.g. a fixed-block settlement scheme).
   * @param {Date|number} tm
   * @param {number} minutes
   * @returns {number} epoch ms of the block start
   */
  static startOfBlock(tm, minutes) {
    const d = new Date(tm);
    d.setUTCMinutes(Math.floor(d.getUTCMinutes() / minutes) * minutes, 0, 0);
    return d.getTime();
  }
}

module.exports = MeterHelpers;
