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
    const deltaMoney = (currentReading.meterValue - currentMoney.meterValue) * tariff;
    return {
      day: currentMoney.day + deltaMoney,
      month: currentMoney.month + deltaMoney,
      year: currentMoney.year + deltaMoney,
      meterValue: currentReading.meterValue,
      lastDay: currentMoney.lastDay,
      lastMonth: currentMoney.lastMonth,
      lastYear: currentMoney.lastYear,
    };
  }
}

module.exports = MeterHelpers;
