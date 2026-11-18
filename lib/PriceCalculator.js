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

  static selectPrices(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end)
      .map((hourInfo) => hourInfo.muPrice);
  }

  static selectExportPrices(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end)
      .map((hourInfo) => hourInfo.exportPrice);
  }

  static getPeriodRange(periods, period) {
    if (period === 'tomorrow') return { start: periods.tomorrowStart, end: periods.tomorrowEnd };
    if (period === 'next_hours') return { start: periods.periodStart, end: new Date(8640000000000000) };
    return { start: periods.todayStart, end: periods.tomorrowStart };
  }

  static selectPriceObjects(prices, start, end) {
    return prices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end);
  }

  static parseTOD(val) {
    if (!val) return null;
    const v = val.replace(/\s/g, '');
    if (v === '' || v === '0' || v === '0:0') return null;

    const entries = v
      .split(';')
      .filter((hm) => hm !== '')
      .map((entry) => {
        const parts = entry.split(':');
        if (parts.length !== 2 && parts.length !== 3) return null;
        const h = Number(parts[0]);
        const m = parts.length === 3 ? Number(parts[1]) : 0;
        const value = Number(parts[parts.length - 1]);
        const valid = parts.every((part) => part !== '') && Number.isInteger(h) && h >= 0 && h < 24
          && [0, 15, 30, 45].includes(m) && Number.isFinite(value);
        return valid ? { quarter: h * 4 + m / 15, value } : null;
      });

    if (entries.length === 0 || entries.includes(null)) throw new Error('Invalid string for TOD');
    entries.sort((a, b) => a.quarter - b.quarter);

    let lastValue = entries[entries.length - 1].value;
    const quarters = [];
    for (let q = 0; q < 96; q += 1) {
      const entry = entries.find((e) => e.quarter === q);
      if (entry) lastValue = entry.value;
      quarters.push(lastValue);
    }
    return quarters;
  }

  static todHasQuarters(val) {
    let tod;
    try {
      tod = PriceCalculator.parseTOD(val);
    } catch {
      return false;
    }
    return !!tod && tod.some((value, q) => q % 4 !== 0 && value !== tod[q - 1]);
  }

  static todAt(tod, localDate) {
    if (!tod) return 0;
    return tod[localDate.getHours() * 4 + Math.floor(localDate.getMinutes() / 15)] || 0;
  }

  static calculateMarkupPrices(marketPrices, settings, timeZone) {
    if (!marketPrices || marketPrices.length === 0) return [];

    const todMarkups = PriceCalculator.parseTOD(settings.fixedMarkupTOD);
    const exportTodMarkups = PriceCalculator.parseTOD(settings.export_fixedMarkupTOD);

    return marketPrices.map((marketPrice) => {
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
        muPrice += PriceCalculator.todAt(todMarkups, priceDate);
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
        exportPrice += PriceCalculator.todAt(exportTodMarkups, priceDate);
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

  static roundPrice(value) {
    return Number.isFinite(value) ? Math.round(value * 1e7) / 1e7 : value;
  }

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
