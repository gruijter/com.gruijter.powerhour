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

  /**
   * Authority ranking of a provider (1 = highest). Determines which source may overwrite which
   * when merging newly fetched prices with the stored prices.
   * Both Entsoe variants share a rank because they deliver the same data (proxy vs direct),
   * so they are always allowed to refresh each other.
   * Mirrors the fetch order of sortProviders(). Unknown/untagged prices rank lowest.
   */
  static getProviderRank(providerName, isNordpoolZone) {
    if (typeof providerName !== 'string') return 99;
    const isEntsoe = providerName.startsWith('ENTSOE');
    if (isNordpoolZone) {
      if (providerName === 'Nordpool') return 1;
      if (isEntsoe) return 2;
      return 3;
    }
    if (isEntsoe) return 1;
    if (providerName === 'Nordpool') return 2;
    return 3;
  }

  /**
   * Merge newly fetched prices with the stored prices, keeping the price of the highest ranking
   * provider per timestamp. This allows a lower ranking provider to deliver tomorrow's prices
   * without overwriting today's prices of a higher ranking provider.
   * The new list defines the shape (range and resolution) of the result, so the consecutive
   * order checked by checkPricesValidity() is preserved.
   */
  static mergeByAuthority(storedPrices, newPrices, isNordpoolZone, logger) {
    if (!Array.isArray(newPrices) || newPrices.length === 0) return newPrices;
    if (!Array.isArray(storedPrices) || storedPrices.length === 0) return newPrices;

    const storedMap = new Map();
    storedPrices.forEach((price) => {
      if (price && price.time && !price.isForecast) {
        const time = new Date(price.time).getTime();
        if (!Number.isNaN(time)) storedMap.set(time, price);
      }
    });

    const kept = new Map();
    const merged = newPrices.map((price) => {
      const time = new Date(price.time).getTime();
      const stored = storedMap.get(time);
      if (!stored) return price;
      if (this.getProviderRank(stored.provider, isNordpoolZone) >= this.getProviderRank(price.provider, isNordpoolZone)) return price;
      kept.set(stored.provider, (kept.get(stored.provider) || 0) + 1);
      return { ...stored, time: new Date(time) };
    });
    merged.provider = newPrices.provider;

    if (kept.size > 0 && logger) {
      const summary = [...kept].map(([name, count]) => `${count} from ${name}`).join(', ');
      logger(`Kept existing prices of a higher ranking provider: ${summary}`);
    }
    return merged;
  }

  static filterProviders(providers, requestedProvider, logger) {
    if (requestedProvider && requestedProvider !== 'AUTO') {
      const selected = providers.filter((p) => p.constructor.name === requestedProvider);
      if (selected.length > 0) {
        if (logger) logger(`Using manually selected provider: ${requestedProvider}`);
        return selected;
      }
      if (logger) {
        logger(`Selected provider ${requestedProvider} not available for this zone, falling back to AUTO.`);
      }
    }
    return providers;
  }

  // Fetch order. Keep in sync with getProviderRank(), which decides who may overwrite who.
  static sortProviders(providers, isNordpoolZone) {
    const getWeight = (name) => {
      if (isNordpoolZone) {
        if (name === 'Nordpool') return 1;
        if (name === 'ENTSOE_GRUIJTER') return 2;
        if (name === 'ENTSOE') return 3;
        return 4;
      }
      // Deprioritize Nordpool for other zones (e.g. NL, DE) to avoid incorrect prices during market decoupling,
      // but keep it above the scraped secondary sources (e.g. Stekker).
      // Prefer EntsoeGruijter (fast/proxy) over Entsoe (slow/direct)
      if (name === 'ENTSOE_GRUIJTER') return 1;
      if (name === 'ENTSOE') return 2;
      if (name === 'Nordpool') return 3;
      return 4;
    };

    providers.sort((a, b) => getWeight(a.name) - getWeight(b.name));
    return providers;
  }

  static getFetchDelay(primaryProviderName) {
    let maxDelay = 5 * 60 * 1000; // default 5 min (Nordpool/others)
    if (primaryProviderName === 'ENTSOE') maxDelay = 45 * 60 * 1000; // Official Entsoe is slow/strict
    if (primaryProviderName === 'ENTSOE_GRUIJTER') maxDelay = 60 * 1000; // Proxy is fast
    return Math.random() * maxDelay;
  }

  static shouldSkipFetch(marketPrices, periods, isNordpoolZone) {
    if (!marketPrices || marketPrices.length === 0) return { skip: false, hasTomorrow: false };

    const hasToday = marketPrices.some((p) => new Date(p.time) >= periods.todayStart);
    // Check if we have prices until the end of tomorrow (at least 23:00)
    const hasTomorrow = marketPrices.some((p) => new Date(p.time).getTime() >= periods.tomorrowEnd.getTime() - 3600000);
    const nowBrussels = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));

    // Before 10:00, no new prices are available anywhere
    if (hasToday && nowBrussels.getHours() < 10) {
      return { skip: true, reason: 'Too early (before 10:00)', hasTomorrow };
    }

    // Unwanted price overrides by a lower ranking provider are prevented by mergeByAuthority(),
    // so all providers may always be tried here.
    if (hasTomorrow) {
      // If we are in a Nordpool zone and have tomorrow's prices, stop (save API calls)
      if (isNordpoolZone) {
        return { skip: true, reason: 'Already have tomorrow prices (Nordpool zone)', hasTomorrow };
      }
      if (nowBrussels.getHours() >= 23) {
        return { skip: true, reason: 'Already have tomorrow prices (after 23:00)', hasTomorrow };
      }
    }

    return { skip: false, hasTomorrow };
  }

  static determineRetry(newMarketPrices, periods, isNordpoolZone, hasNordpool) {
    if (!newMarketPrices) {
      return { minutes: 15, reason: 'All providers failed to fetch valid prices' };
    }

    const hasTomorrow = newMarketPrices.some((p) => new Date(p.time) >= periods.tomorrowStart);
    if (!hasTomorrow) {
      const nowBrussels = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
      const hour = nowBrussels.getHours();

      // Nordpool publishes ~10:00, Entsoe ~13:00
      if (hour >= 13) {
        return { minutes: 10, reason: 'Missing tomorrow market prices after 13:00' };
      }
      if (hour >= 10 && (isNordpoolZone || hasNordpool)) {
        return { minutes: 15, reason: 'Missing tomorrow market prices (Nordpool available) after 10:00' };
      }
    }

    return null;
  }

  static async fetchPrices(providers, periods, resolution, validator, logger) {
    let newMarketPrices = null;

    if (logger) logger(`Starting fetch loop with providers: ${providers.map((p) => p.name).join(', ')}`);

    for (const provider of providers) {
      const providerName = provider.constructor.name;
      try {
        const prices = await provider.getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd, resolution });
        await validator(prices); // Should throw if invalid or session changed

        // Tag every price with its source, so mergeByAuthority() can protect it later on
        const tagged = prices.map((price) => ({ ...price, provider: providerName }));
        tagged.provider = providerName;

        const hasTomorrow = tagged.some((p) => new Date(p.time).getTime() >= periods.tomorrowEnd.getTime() - 3600000);
        if (hasTomorrow) {
          if (logger) logger(`Got tomorrow's prices from ${providerName}`);
          return tagged;
        }

        // Keep the prices that extend furthest into the future (on a tie the higher ranking provider wins)
        if (!newMarketPrices || tagged[tagged.length - 1].time > newMarketPrices[newMarketPrices.length - 1].time) {
          newMarketPrices = tagged;
        }
        if (logger) logger(`${providerName} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err; // Abort immediately
        if (err.message !== 'Fetched prices are older then the stored prices') {
          if (logger) logger(`Error fetching from ${providerName}: ${err.message}`);
        } else if (logger) {
          logger(`${providerName} returned prices older than stored prices. Skipping...`);
        }
      }
    }
    return newMarketPrices;
  }

}

module.exports = PriceFetchStrategy;
