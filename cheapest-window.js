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

/**
 * Calculate the cheapest window from a price array
 *
 * @param {Array} prices - Array of price objects with { time, muPrice }
 * @param {Object} args - Arguments object with { windowSize, lookahead }
 * @param {Date} periodStart - The start of the current period (for filtering)
 * @param {number} priceInterval - Price interval in minutes (60 for hourly, 15 for quarter-hourly)
 * @returns {Object} Result with isNowCheapest, hoursUntil, quartersUntil, minutesUntil, cheapestAvgPrice, cheapestStartHour
 */
function calculateCheapestWindow(prices, args, periodStart, priceInterval = 60) {
  const { windowSize, lookahead } = args;

  // Get lookahead in minutes
  const lookaheadMinutes = lookahead * 60;
  const lookaheadEnd = new Date(periodStart.getTime() + lookaheadMinutes * 60 * 1000);

  // Filter prices within lookahead period
  const upcomingPrices = prices.filter((p) => {
    const priceTime = new Date(p.time);
    return priceTime >= periodStart && priceTime < lookaheadEnd;
  });

  if (upcomingPrices.length < windowSize) {
    return {
      isNowCheapest: false,
      hoursUntil: null,
      quartersUntil: null,
      minutesUntil: null,
      cheapestAvgPrice: null,
      cheapestStartHour: null,
    };
  }

  // Build windows
  const windows = [];
  for (let start = 0; start <= upcomingPrices.length - windowSize; start += 1) {
    const windowPrices = upcomingPrices.slice(start, start + windowSize);
    const avgPrice = windowPrices.reduce((sum, p) => sum + p.muPrice, 0) / windowSize;
    const startTime = new Date(windowPrices[0].time);
    const periodsFromNow = Math.round((startTime - periodStart) / (priceInterval * 60 * 1000));

    windows.push({
      startIndex: start,
      avgPrice,
      startTime,
      periodsFromNow,
      startHour: startTime.getUTCHours(),
    });
  }

  if (windows.length === 0) {
    return {
      isNowCheapest: false,
      hoursUntil: null,
      quartersUntil: null,
      minutesUntil: null,
      cheapestAvgPrice: null,
      cheapestStartHour: null,
    };
  }

  // Find cheapest window
  const cheapest = windows.reduce((min, w) => (w.avgPrice < min.avgPrice ? w : min));

  // Calculate time until cheapest in different units
  const minutesUntil = cheapest.periodsFromNow * priceInterval;
  const hoursUntil = Math.floor(minutesUntil / 60);
  const quartersUntil = Math.floor(minutesUntil / 15);

  // Check if we're currently in the cheapest window
  const isNowCheapest = cheapest.startIndex === 0;

  return {
    isNowCheapest,
    hoursUntil,
    quartersUntil,
    minutesUntil,
    cheapestAvgPrice: Math.round(cheapest.avgPrice * 10000) / 10000,
    cheapestStartHour: cheapest.startHour,
  };
}

/**
 * Calculate periods until cheapest window starts
 *
 * @param {Array} prices - Array of price objects with { muPrice }
 * @param {number} windowSize - Number of periods in the window
 * @returns {Object} Result with periodsUntil and avgPrice
 */
function calculatePeriodsUntilCheapest(prices, windowSize) {
  if (!prices || prices.length < windowSize) return { periodsUntil: null, avgPrice: null };

  const windows = [];
  for (let start = 0; start <= prices.length - windowSize; start += 1) {
    const windowPrices = prices.slice(start, start + windowSize);
    const avgPrice = windowPrices.reduce((sum, p) => sum + p.muPrice, 0) / windowSize;
    windows.push({
      startIndex: start,
      avgPrice,
    });
  }

  if (windows.length === 0) return { periodsUntil: null, avgPrice: null };

  // Find cheapest window
  const cheapest = windows.reduce((min, w) => (w.avgPrice < min.avgPrice ? w : min));

  return {
    periodsUntil: cheapest.startIndex,
    avgPrice: cheapest.avgPrice,
  };
}

module.exports = {
  calculateCheapestWindow,
  calculatePeriodsUntilCheapest,
};
