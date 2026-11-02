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

const TimeHelpers = require('./helpers/TimeHelpers');

class PriceCalculator {

  static average(array) {
    if (!array || array.length === 0) return 0;
    return array.reduce((a, b) => a + b, 0) / array.length;
  }

  /**
   * Filter prices within a specific time range and return their values
   * @param {object[]} prices - Array of {time, price, muPrice}
   * @param {Date} start
   * @param {Date} end
   * @returns {number[]} Array of muPrices
   */
  static selectPrices(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end)
      .map((hourInfo) => hourInfo.muPrice);
  }

  /**
   * Filter prices within a specific time range and return their export values
   * @param {object[]} prices - Array of {time, price, exportPrice}
   * @param {Date} start
   * @param {Date} end
   * @returns {number[]} Array of exportPrices
   */
  static selectExportPrices(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end)
      .map((hourInfo) => hourInfo.exportPrice);
  }

  /**
   * Flow-card period name to the half-open UTC range [start, end). 'next_hours' ends at the
   * largest Date.
   * @param {object} periods - from TimeHelpers.getUTCPeriods()
   * @param {string} period - 'this_day', 'tomorrow' or 'next_hours'
   * @returns {{start: Date, end: Date}}
   */
  static getPeriodRange(periods, period) {
    if (period === 'tomorrow') return { start: periods.tomorrowStart, end: periods.tomorrowEnd };
    if (period === 'next_hours') return { start: periods.periodStart, end: new Date(8640000000000000) };
    return { start: periods.todayStart, end: periods.tomorrowStart };
  }

  /**
   * Select price objects within a specific time range
   * @param {object[]} prices - Array of {time, price, muPrice}
   * @param {Date} start
   * @param {Date} end
   * @returns {object[]} Array of price objects
   */
  static selectPriceObjects(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end);
  }

  /**
   * Parse Time Of Day string to object 0-24
   * @param {string} val
   * @returns {object|null}
   */
  static parseTOD(val) {
    if (!val) return null;
    const v = val.replace(/\s/g, '');
    if (v === '' || v === '0' || v === '0:0') return null;

    const hours = v
      .split(';')
      .filter((hm) => hm !== '')
      .sort((a, b) => {
        const hA = parseInt(a.split(':')[0], 10);
        const hB = parseInt(b.split(':')[0], 10);
        return hA - hB;
      })
      .map((hour) => {
        const hm = hour.split(':');
        let valid = hm.length === 2;
        if (valid) {
          const h = Number(hm[0]);
          const m = Number(hm[1]);
          valid = valid && Number.isInteger(h) && h >= 0 && h < 24 && Number.isFinite(m);
          if (valid) return [`${h}`, m];
        }
        return null;
      });

    if (hours.includes(null)) throw new Error('Invalid string for TOD');

    const todObject = {};
    // Hours before the first entry take the last entry's value (from the previous day).
    let lastValue = hours.slice(-1)[0][1];

    for (let i = 0; i < 24; i += 1) {
      const hm = hours.find((x) => Number(x[0]) === i);
      const value = hm ? hm[1] : lastValue;
      todObject[i] = Number(value);
      lastValue = value;
    }
    return todObject;
  }

  /**
   * Apply markups to raw market prices
   * @param {object[]} marketPrices - Array of {time, price}
   * @param {object} settings - Settings object
   * @param {number} settings.exchangeRate
   * @param {number} settings.variableMarkup
   * @param {number} settings.variableMarkupAbsPrice
   * @param {number} settings.fixedMarkup
   * @param {number} settings.fixedMarkupWeekend
   * @param {string} settings.fixedMarkupTOD
   * @param {boolean} settings.ignore_market_price
   * @param {boolean} settings.export_ignore_market_price
   * @param {number} settings.export_fixedMarkup
   * @param {string} [timeZone] - Timezone for TOD calculations
   * @returns {object[]} Array of {time, price, muPrice, importPrice, exportPrice}
   */
  static calculateMarkupPrices(marketPrices, settings, timeZone) {
    if (!marketPrices || marketPrices.length === 0) return [];

    const todMarkups = PriceCalculator.parseTOD(settings.fixedMarkupTOD);
    const exportTodMarkups = PriceCalculator.parseTOD(settings.export_fixedMarkupTOD);

    return marketPrices.map((marketPrice) => {
      // 1. Exchange rate and MWh -> kWh conversion
      const importRaw = settings.ignore_market_price ? 0 : marketPrice.price;
      let muPrice = (importRaw * settings.exchangeRate) / 1000;

      if (!settings.ignore_market_price) {
        let variableMarkup = settings.variableMarkup || 0;
        const variableMarkupAbsPrice = settings.variableMarkupAbsPrice || 0;
        const effectiveAbsMarkup = (importRaw < 0) ? -variableMarkupAbsPrice : variableMarkupAbsPrice;

        if (effectiveAbsMarkup) variableMarkup += effectiveAbsMarkup;
        muPrice *= (1 + variableMarkup / 100);
      }

      muPrice += (settings.fixedMarkup || 0);

      const priceDate = TimeHelpers.toLocalDate(new Date(marketPrice.time), timeZone || 'UTC');
      const isWeekend = priceDate.getDay() === 0 || priceDate.getDay() === 6;

      if (settings.fixedMarkupWeekend && isWeekend) {
        muPrice += settings.fixedMarkupWeekend;
      } else if (todMarkups) {
        muPrice += todMarkups[priceDate.getHours().toString()] || 0;
      }

      const exportRaw = settings.export_ignore_market_price ? 0 : marketPrice.price;
      let exportPrice = (exportRaw * settings.exchangeRate) / 1000;

      if (!settings.export_ignore_market_price) {
        let exportVariableMarkup = settings.export_variableMarkup || 0;
        const exportVariableMarkupAbsPrice = settings.export_variableMarkupAbsPrice || 0;
        const exportEffectiveAbsMarkup = (exportRaw < 0) ? -exportVariableMarkupAbsPrice : exportVariableMarkupAbsPrice;

        if (exportEffectiveAbsMarkup) exportVariableMarkup += exportEffectiveAbsMarkup;
        exportPrice *= (1 + exportVariableMarkup / 100);
      }

      exportPrice += (settings.export_fixedMarkup || 0);

      if (settings.export_fixedMarkupWeekend && isWeekend) {
        exportPrice += settings.export_fixedMarkupWeekend;
      } else if (exportTodMarkups) {
        exportPrice += exportTodMarkups[priceDate.getHours().toString()] || 0;
      }

      return {
        time: marketPrice.time,
        price: marketPrice.price,
        muPrice: PriceCalculator.roundPrice(muPrice),
        importPrice: PriceCalculator.roundPrice(muPrice),
        exportPrice: PriceCalculator.roundPrice(exportPrice),
        isForecast: marketPrice.isForecast,
      };
    });
  }

  // A price without float noise (e.g. 0.35579130000000003): 7 decimals, as a price per MWh with 2
  // decimals and 21 % VAT has.
  static roundPrice(value) {
    return Number.isFinite(value) ? Math.round(value * 1e7) / 1e7 : value;
  }

  /**
   * Calculate statistics for a set of prices
   * @param {number[]} prices
   * @returns {object} { min, max, avg, minIndex, maxIndex }
   */
  static calculateStats(prices) {
    if (!prices || prices.length === 0) {
      return {
        min: null, max: null, avg: null, minIndex: -1, maxIndex: -1,
      };
    }
    const avg = PriceCalculator.roundPrice(PriceCalculator.average(prices));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const minIndex = prices.indexOf(min);
    const maxIndex = prices.indexOf(max);
    return {
      min, max, avg, minIndex, maxIndex,
    };
  }
}

module.exports = PriceCalculator;
