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

// A provider declaring a spread window larger than this is not called straight away, but gets its
// own random moment within the window, so not all Homeys hit the API right after the hour.
const SPREAD_THRESHOLD = 10 * 60 * 1000;
const BASE_BACKOFF = 15 * 60 * 1000; // first wait after a failed call, doubles on every next failure

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
   * A provider that the user selected by hand always outranks the rest: their choice wins.
   */
  static getProviderRank(providerName, isNordpoolZone, preferred) {
    if (typeof providerName !== 'string') return 99;
    if (preferred && providerName === preferred) return 0;
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
  static mergeByAuthority(storedPrices, newPrices, isNordpoolZone, logger, preferred) {
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
      if (this.getProviderRank(stored.provider, isNordpoolZone, preferred) >= this.getProviderRank(price.provider, isNordpoolZone, preferred)) return price;
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

  /**
   * Rate limit of a provider, filled out with defaults for providers that declare only part of it.
   */
  static getRateLimit(provider) {
    const defaults = {
      minDelay: 30000, maxRandomDelay: 5 * 60 * 1000, minInterval: 5 * 60 * 1000, maxBackoff: 2 * 60 * 60 * 1000,
    };
    const declared = (provider && typeof provider.getRateLimit === 'function') ? provider.getRateLimit() : {};
    return { ...defaults, ...declared };
  }

  // Providers with a large spread window are called on their own moment, see reserveSpread()
  static needsSpreading(provider) {
    return this.getRateLimit(provider).maxRandomDelay >= SPREAD_THRESHOLD;
  }

  /**
   * Delay of the scheduled fetch, based on the highest priority provider that is called straight
   * away. Providers that need spreading schedule their own moment, so they are not counted here.
   */
  static getFetchDelay(providers) {
    const direct = (providers || []).filter((provider) => !this.needsSpreading(provider));
    const maxDelay = direct.length > 0 ? this.getRateLimit(direct[0]).maxRandomDelay : 5 * 60 * 1000;
    return Math.random() * maxDelay;
  }

  /**
   * Check if a provider could add or improve anything, based on the source tags of the stored prices.
   * Returns false when today and tomorrow are complete and held by an equal or higher ranking
   * provider, in which case calling the API would be a waste.
   */
  static canImprove(storedPrices, providerName, periods, isNordpoolZone, priceInterval, preferred) {
    if (!Array.isArray(storedPrices) || storedPrices.length === 0) return true;

    const start = periods.todayStart.getTime();
    const end = periods.tomorrowEnd.getTime();
    const expected = Math.round((end - start) / (priceInterval * 60 * 1000));
    const rank = this.getProviderRank(providerName, isNordpoolZone, preferred);

    let covered = 0;
    let improvable = false;
    storedPrices.forEach((price) => {
      if (!price || !price.time || price.isForecast) return;
      const time = new Date(price.time).getTime();
      if (Number.isNaN(time) || time < start || time >= end) return;
      covered += 1;
      if (this.getProviderRank(price.provider, isNordpoolZone, preferred) > rank) improvable = true;
    });

    return improvable || covered < expected;
  }

  /**
   * Give a provider with a large spread window its own random moment within that window.
   * Returns the reserved timestamp on the first encounter, and null once that moment has been
   * reserved, so the next attempt actually calls the provider.
   */
  static reserveSpread(callState, provider, now) {
    if (!this.needsSpreading(provider)) return null;
    const { name } = provider.constructor;
    const state = callState.get(name) || { failures: 0, nextAllowed: 0, spreadReserved: false };
    if (state.spreadReserved) return null;
    state.spreadReserved = true;
    state.nextAllowed = now + (Math.random() * this.getRateLimit(provider).maxRandomDelay);
    callState.set(name, state);
    return state.nextAllowed;
  }

  /**
   * Record the result of a call. A successful call is followed by the provider's minimum interval,
   * a failed call by an exponential backoff, so a provider that is down is not hammered.
   */
  static registerCall(callState, provider, success, now) {
    const { name } = provider.constructor;
    const { minInterval, maxBackoff } = this.getRateLimit(provider);
    const state = callState.get(name) || { failures: 0, nextAllowed: 0, spreadReserved: false };
    state.spreadReserved = false;
    if (success) {
      state.failures = 0;
      state.nextAllowed = now + minInterval;
    } else {
      state.failures += 1;
      const backoff = Math.min(maxBackoff, BASE_BACKOFF * (2 ** (state.failures - 1)));
      state.nextAllowed = now + Math.max(minInterval, backoff);
    }
    callState.set(name, state);
    return state;
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

  /**
   * Run the fetch loop over the prioritized providers.
   * A provider is only called when it can actually improve the stored prices (canImprove) and when
   * its rate limit allows it. Providers that are skipped because of their rate limit or because of
   * spreading are reported back in deferredUntil, so the caller can retry at that moment.
   * @returns {Promise<object>} { prices, deferredUntil, called }
   */
  static async fetchPrices(providers, periods, resolution, validator, logger, options = {}) {
    const {
      storedPrices = [], isNordpoolZone = false, priceInterval = 60, callState = new Map(), preferred = null,
    } = options;

    let newMarketPrices = null;
    let deferredUntil = null;
    let called = 0;
    const now = Date.now();
    const defer = (time) => {
      deferredUntil = deferredUntil === null ? time : Math.min(deferredUntil, time);
    };

    if (logger) logger(`Starting fetch loop with providers: ${providers.map((p) => p.name).join(', ')}`);

    for (const provider of providers) {
      const providerName = provider.constructor.name;

      if (!this.canImprove(storedPrices, providerName, periods, isNordpoolZone, priceInterval, preferred)) {
        if (logger) logger(`Skipping ${providerName}: stored prices are complete and from an equal or higher ranking provider`);
        continue;
      }

      const state = callState.get(providerName);
      if (state && state.nextAllowed > now) {
        defer(state.nextAllowed);
        if (logger) logger(`Skipping ${providerName}: rate limited for another ${Math.round((state.nextAllowed - now) / 60000)} min`);
        continue;
      }

      const spreadUntil = this.reserveSpread(callState, provider, now);
      if (spreadUntil) {
        defer(spreadUntil);
        if (logger) logger(`Spreading ${providerName}: postponed by ${Math.round((spreadUntil - now) / 60000)} min`);
        continue;
      }

      called += 1;
      let apiReplied = false;
      try {
        const prices = await provider.getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd, resolution });
        apiReplied = true;
        this.registerCall(callState, provider, true, Date.now());
        await validator(prices); // Should throw if invalid or session changed

        // Tag every price with its source, so mergeByAuthority() can protect it later on
        const tagged = prices.map((price) => ({ ...price, provider: providerName }));
        tagged.provider = providerName;

        const hasTomorrow = tagged.some((p) => new Date(p.time).getTime() >= periods.tomorrowEnd.getTime() - 3600000);
        if (hasTomorrow) {
          if (logger) logger(`Got tomorrow's prices from ${providerName}`);
          return { prices: tagged, deferredUntil, called };
        }

        // Keep the prices that extend furthest into the future (on a tie the higher ranking provider wins)
        if (!newMarketPrices || tagged[tagged.length - 1].time > newMarketPrices[newMarketPrices.length - 1].time) {
          newMarketPrices = tagged;
        }
        if (logger) logger(`${providerName} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err; // Abort immediately
        // Only a failing API call counts as a failure and triggers backoff. Content that is
        // rejected afterwards (e.g. older than stored) means the API itself is doing fine.
        if (!apiReplied) this.registerCall(callState, provider, false, Date.now());
        if (err.message !== 'Fetched prices are older then the stored prices') {
          if (logger) logger(`Error fetching from ${providerName}: ${err.message}`);
        } else if (logger) {
          logger(`${providerName} returned prices older than stored prices. Skipping...`);
        }
      }
    }
    return { prices: newMarketPrices, deferredUntil, called };
  }

}

module.exports = PriceFetchStrategy;
