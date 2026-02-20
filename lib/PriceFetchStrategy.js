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

const nordpoolZones = [
  '10YNO-1--------2', '10YNO-2--------T', '10YNO-3--------J', '10YNO-4--------9', '10Y1001A1001A48H', // NO
  '10Y1001A1001A44P', '10Y1001A1001A45N', '10Y1001A1001A46L', '10Y1001A1001A47J', // SE
  '10YDK-1--------W', '10YDK-2--------M', // DK
  '10YFI-1--------U', // FI
  '10Y1001A1001A39I', // EE
  '10YLV-1001A00074', // LV
  '10YLT-1001A0008Q', // LT
];

class PriceFetchStrategy {

  static isNordpoolZone(biddingZone) {
    return biddingZone && nordpoolZones.includes(biddingZone);
  }

  static sortProviders(providers, isNordpoolZone) {
    if (isNordpoolZone) {
      providers.sort((a, b) => {
        if (a.name === 'Nordpool') return -1;
        if (b.name === 'Nordpool') return 1;
        return 0;
      });
    } else {
      // Deprioritize Nordpool for other zones (e.g. NL, DE) to avoid incorrect prices during market decoupling
      // Prefer EntsoeGruijter (fast/proxy) over Entsoe (slow/direct)
      providers.sort((a, b) => {
        if (a.name === 'Nordpool') return 1;
        if (b.name === 'Nordpool') return -1;
        if (a.name === 'ENTSOE_GRUIJTER') return -1;
        if (b.name === 'ENTSOE_GRUIJTER') return 1;
        return 0;
      });
    }
    return providers;
  }

  static getFetchDelay(primaryProviderName) {
    let maxDelay = 5 * 60 * 1000; // default 5 min (Nordpool/others)
    if (primaryProviderName === 'ENTSOE') maxDelay = 45 * 60 * 1000; // Official Entsoe is slow/strict
    if (primaryProviderName === 'ENTSOE_GRUIJTER') maxDelay = 60 * 1000; // Proxy is fast
    return Math.random() * maxDelay;
  }

  static shouldSkipFetch(marketPrices, periods, isNordpoolZone) {
    if (!marketPrices || marketPrices.length === 0) return false;

    const hasToday = marketPrices.some((p) => new Date(p.time) >= periods.todayStart);
    const hasTomorrow = marketPrices.some((p) => new Date(p.time) >= periods.tomorrowStart);
    const nowBrussels = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));

    // Before 10:00, no new prices are available anywhere
    if (hasToday && nowBrussels.getHours() < 10) {
      return { skip: true, reason: 'Too early (before 10:00)' };
    }

    // If we are in a Nordpool zone and have tomorrow's prices, stop (save API calls)
    if (isNordpoolZone && hasTomorrow) {
      return { skip: true, reason: 'Already have tomorrow prices (Nordpool zone)' };
    }

    return { skip: false };
  }

  static async fetchPrices(providers, periods, resolution, validator, logger) {
    let newMarketPrices = null;

    for (const provider of providers) {
      try {
        const prices = await provider.getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd, resolution });
        await validator(prices); // Should throw if invalid or session changed

        const hasTomorrow = prices.some((p) => new Date(p.time) >= periods.tomorrowStart);
        if (hasTomorrow) {
          logger(`Got tomorrow's prices from ${provider.constructor.name}`);
          return prices;
        }

        if (!newMarketPrices) newMarketPrices = prices;
        logger(`${provider.constructor.name} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err; // Abort immediately
        if (err.message !== 'Fetched prices are older then the stored prices') {
          logger(`Error fetching from ${provider.constructor.name}: ${err.message}`);
        }
      }
    }
    return newMarketPrices;
  }

}

module.exports = PriceFetchStrategy;
