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

class PriceCalculator {

  /**
   * Calculate the average of an array of numbers
   * @param {number[]} array
   * @returns {number}
   */
  static average(array) {
    if (!array || array.length === 0) return 0;
    return array.reduce((partialAvg, value) => partialAvg + value / array.length, 0);
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
    let lastValue = hours.slice(-1)[0][1]; // Use the last value as initial "wrap around" if needed, logic preserved from original
    // Actually original logic:
    // let lastValue = hours.slice(-1)[0][1];
    // for (let i = 0; i < 24; i += 1) { ... }

    // If we sort them, we need to handle the filling correctly.
    // The original logic assumes the array is sorted by hour.

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
   * @param {string} [timeZone] - Timezone for TOD calculations
   * @returns {object[]} Array of {time, price, muPrice}
   */
  static calculateMarkupPrices(marketPrices, settings, timeZone) {
    if (!marketPrices || marketPrices.length === 0) return [];

    const todMarkups = PriceCalculator.parseTOD(settings.fixedMarkupTOD);

    return marketPrices.map((marketPrice) => {
      // 1. Exchange rate and mWh -> kWh conversion
      // NOTE: Original code: (marketPrice.price * this.settings.exchangeRate) / 1000;
      let muPrice = (marketPrice.price * settings.exchangeRate) / 1000;

      // 2. Variable markup
      let { variableMarkup } = settings;
      const { variableMarkupAbsPrice } = settings;
      // Handle negative prices for abs markup logic
      // Original: variableMarkupAbsPrice = (marketPrice.price < 0) ? -variableMarkupAbsPrice : variableMarkupAbsPrice;
      const effectiveAbsMarkup = (marketPrice.price < 0) ? -variableMarkupAbsPrice : variableMarkupAbsPrice;

      if (effectiveAbsMarkup) variableMarkup += effectiveAbsMarkup;
      muPrice *= (1 + variableMarkup / 100);

      // 3. Fixed markup
      muPrice += settings.fixedMarkup;

      // 4. TOD and Weekend markups
      const priceDate = new Date(new Date(marketPrice.time).toLocaleString('en-US', { timeZone: timeZone || 'UTC' }));
      const isWeekend = priceDate.getDay() === 0 || priceDate.getDay() === 6;

      if (settings.fixedMarkupWeekend && isWeekend) {
        muPrice += settings.fixedMarkupWeekend;
      } else if (todMarkups) {
        muPrice += todMarkups[priceDate.getHours().toString()] || 0;
      }

      return {
        time: marketPrice.time,
        price: marketPrice.price,
        muPrice,
        isForecast: marketPrice.isForecast,
      };
    });
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
    const avg = PriceCalculator.average(prices);
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
