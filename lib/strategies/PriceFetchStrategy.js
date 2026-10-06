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

const { DEFAULT_RATE_LIMIT } = require('../providers/PriceProvider');
const TimeHelpers = require('../helpers/TimeHelpers');

const nordpoolZones = [
  '10YNO-1--------2', '10YNO-2--------T', '10YNO-3--------J', '10YNO-4--------9', '10Y1001A1001A48H', // NO
  '10Y1001A1001A44P', '10Y1001A1001A45N', '10Y1001A1001A46L', '10Y1001A1001A47J', // SE
  '10YDK-1--------W', '10YDK-2--------M', // DK
  '10YFI-1--------U', // FI
  '10Y1001A1001A39I', // EE
  '10YLV-1001A00074', // LV
  '10YLT-1001A0008Q', // LT
];

// A provider with a spread window larger than this gets its own random moment within it, so not
// all Homeys call the API right after the hour.
const SPREAD_THRESHOLD = 10 * 60 * 1000;
const BASE_BACKOFF = 15 * 60 * 1000; // first wait after a failed call, doubles on every next failure

// How far fetched prices may fall short of the end of tomorrow and still count as complete: a
// zone's market day need not match the Homey's civil day (e.g. PT/IE trade on a CET day). All
// current zone pairs differ by at most one hour. Not a per-zone table on purpose (goes stale).
const MARKET_DAY_TOLERANCE = 60 * 60 * 1000;

class PriceFetchStrategy {

  static isNordpoolZone(biddingZone) {
    return biddingZone && nordpoolZones.includes(biddingZone);
  }

  /**
   * Authority ranking of a provider (1 = highest): which source may overwrite which when merging.
   * Both Entsoe variants share a rank (same data). Mirrors sortProviders(); unknown ranks lowest.
   * A provider selected by the user outranks the rest.
   */
  static getProviderRank(providerName, isNordpoolZone, preferred) {
    if (typeof providerName !== 'string') return 99;
    if (preferred && providerName === preferred) return 0;
    const isEntsoe = providerName.startsWith('ENTSOE');
    if (isNordpoolZone) {
      if (providerName === 'Nordpool') return 1;
      if (isEntsoe) return 2;
      if (providerName === 'SMARD') return 3;
      return 4;
    }
    // OMIE runs the Iberian auction: primary for ES/PT (it only declares those zones).
    if (providerName === 'OMIE') return 1;
    if (isEntsoe) return 2;
    // SMARD (Bundesnetzagentur) ranks above the scraped sources, below ENTSOE.
    if (providerName === 'SMARD') return 3;
    if (providerName === 'Nordpool') return 4;
    return 5;
  }

  /**
   * Merge newly fetched prices with the stored prices, keeping the highest ranking provider's price
   * per timestamp. The new list defines range and resolution of the result.
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
        if (name === 'SMARD') return 4;
        return 5;
      }
      // Nordpool deprioritized outside its zones (market decoupling), but above scraped sources.
      // EntsoeGruijter (proxy) before Entsoe (direct).
      if (name === 'OMIE') return 1;
      if (name === 'ENTSOE_GRUIJTER') return 2;
      if (name === 'ENTSOE') return 3;
      if (name === 'SMARD') return 4;
      if (name === 'Nordpool') return 5;
      return 6;
    };

    providers.sort((a, b) => getWeight(a.name) - getWeight(b.name));
    return providers;
  }

  /**
   * Rate limit of a provider, filled out with defaults for providers that declare only part of it.
   */
  static getRateLimit(provider) {
    const declared = (provider && typeof provider.getRateLimit === 'function') ? provider.getRateLimit() : {};
    return { ...DEFAULT_RATE_LIMIT, ...declared };
  }

  // see reserveSpread()
  static needsSpreading(provider) {
    return this.getRateLimit(provider).maxRandomDelay >= SPREAD_THRESHOLD;
  }

  /**
   * Delay of the scheduled fetch, from the highest priority provider that is called straight away.
   */
  static getFetchDelay(providers) {
    const direct = (providers || []).filter((provider) => !this.needsSpreading(provider));
    const maxDelay = direct.length > 0 ? this.getRateLimit(direct[0]).maxRandomDelay : 5 * 60 * 1000;
    return Math.random() * maxDelay;
  }

  /**
   * Whether a provider could add or improve anything, from the source tags of the stored prices.
   * false when today and tomorrow are complete and held by an equal or higher ranking provider.
   */
  static canImprove(storedPrices, providerName, periods, isNordpoolZone, priceInterval, preferred) {
    if (!Array.isArray(storedPrices) || storedPrices.length === 0) return true;

    const start = periods.todayStart.getTime();
    const end = periods.tomorrowEnd.getTime();
    // Minus MARKET_DAY_TOLERANCE, as in coversTomorrow(): else an offset zone is fetched every cycle.
    const expected = Math.round((end - start - MARKET_DAY_TOLERANCE) / (priceInterval * 60 * 1000));
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
   * Whether a price series reaches far enough into tomorrow to stop asking further providers.
   * Compares the END of the last interval (price.time is its start) against tomorrowEnd.
   * @param {object[]} prices [{ time, price }]
   * @param {object} periods from TimeHelpers.getUTCPeriods()
   * @param {number} priceInterval in minutes
   * @returns {boolean}
   */
  static coversTomorrow(prices, periods, priceInterval) {
    if (!Array.isArray(prices) || prices.length === 0) return false;
    let lastStart = 0;
    prices.forEach((price) => {
      if (!price || !price.time) return;
      const time = new Date(price.time).getTime();
      if (!Number.isNaN(time) && time > lastStart) lastStart = time;
    });
    if (!lastStart) return false;
    const coverageEnd = lastStart + (priceInterval * 60 * 1000);
    return coverageEnd >= periods.tomorrowEnd.getTime() - MARKET_DAY_TOLERANCE;
  }

  /**
   * Hand back a spread reservation for a provider that was not called after all, or its mark
   * would stay and it would be called at the top of the hour next time. nextAllowed is kept.
   */
  static releaseSpread(callState, provider) {
    const state = callState.get(provider.constructor.name);
    if (state && state.spreadReserved) {
      state.spreadReserved = false;
      callState.set(provider.constructor.name, state);
    }
  }

  /**
   * Give a provider with a large spread window its own random moment within it. Returns that
   * moment on the first encounter, null once reserved (the next attempt calls the provider).
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
   * Best (lowest) rank in the stored prices for today and tomorrow, or 99 when none.
   */
  static getBestStoredRank(storedPrices, periods, isNordpoolZone, preferred) {
    if (!Array.isArray(storedPrices)) return 99;
    const start = periods.todayStart.getTime();
    const end = periods.tomorrowEnd.getTime();
    let best = 99;
    storedPrices.forEach((price) => {
      if (!price || !price.time || price.isForecast) return;
      const time = new Date(price.time).getTime();
      if (Number.isNaN(time) || time < start || time >= end) return;
      const rank = this.getProviderRank(price.provider, isNordpoolZone, preferred);
      if (rank < best) best = rank;
    });
    return best;
  }

  /**
   * Whether a provider should re-fetch prices it already covers, for corrections (only with a
   * revalidateInterval). After a restart one revalidation is allowed.
   */
  static needsRevalidation(callState, provider, now) {
    const { revalidateInterval } = this.getRateLimit(provider);
    if (!revalidateInterval) return false;
    const state = callState.get(provider.constructor.name);
    if (!state || !state.lastSuccess) return true;
    return (now - state.lastSuccess) >= revalidateInterval;
  }

  /**
   * Record the result of a call: a minimum interval after success, exponential backoff after failure.
   */
  static registerCall(callState, provider, success, now, validated = success) {
    const { name } = provider.constructor;
    const { minInterval, maxBackoff } = this.getRateLimit(provider);
    const state = callState.get(name) || { failures: 0, nextAllowed: 0, spreadReserved: false };
    state.spreadReserved = false;
    if (success) {
      state.failures = 0;
      // `validated`: the answer had usable prices. A 200 with stale or short prices must not use up the
      // revalidation window.
      if (validated) state.lastSuccess = now;
      state.nextAllowed = now + minInterval;
    } else {
      state.failures += 1;
      const backoff = Math.min(maxBackoff, BASE_BACKOFF * (2 ** (state.failures - 1)));
      state.nextAllowed = now + Math.max(minInterval, backoff);
    }
    callState.set(name, state);
    return state;
  }

  static shouldSkipFetch(marketPrices, periods) {
    if (!marketPrices || marketPrices.length === 0) return { skip: false, hasTomorrow: false };

    const hasToday = marketPrices.some((p) => new Date(p.time) >= periods.todayStart);
    const nowBrussels = TimeHelpers.toLocalDate(new Date(), 'Europe/Brussels');

    // Before 10:00, no new prices are available anywhere
    if (hasToday && nowBrussels.getHours() < 10) {
      return { skip: true, reason: 'Too early (before 10:00)' };
    }

    return { skip: false };
  }

  static determineRetry(newMarketPrices, periods, isNordpoolZone, hasNordpool) {
    if (!newMarketPrices) {
      return { minutes: 15, reason: 'All providers failed to fetch valid prices' };
    }

    const hasTomorrow = newMarketPrices.some((p) => new Date(p.time) >= periods.tomorrowStart);
    if (!hasTomorrow) {
      const nowBrussels = TimeHelpers.toLocalDate(new Date(), 'Europe/Brussels');
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
   * Fetch loop over the prioritized providers: a provider is called when it can improve the stored
   * prices and its rate limit allows. Deferred providers are reported in deferredUntil.
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
    const bestStoredRank = this.getBestStoredRank(storedPrices, periods, isNordpoolZone, preferred);
    const defer = (time) => {
      deferredUntil = deferredUntil === null ? time : Math.min(deferredUntil, time);
    };

    if (logger) logger(`Starting fetch loop with providers: ${providers.map((p) => p.name).join(', ')}`);

    for (const provider of providers) {
      const providerName = provider.constructor.name;

      const canImprove = this.canImprove(storedPrices, providerName, periods, isNordpoolZone, priceInterval, preferred);
      const mayRevalidate = this.getProviderRank(providerName, isNordpoolZone, preferred) <= bestStoredRank
        && this.needsRevalidation(callState, provider, now);
      if (!canImprove && !mayRevalidate) {
        this.releaseSpread(callState, provider);
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
        const prices = await provider.getPrices({
          dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd, resolution, revalidateOnly: !canImprove,
        });
        apiReplied = true;
        // The API answered; counted as success for revalidation only after validation.
        this.registerCall(callState, provider, true, Date.now(), false);
        await validator(prices); // throws if invalid or session changed
        this.registerCall(callState, provider, true, Date.now());

        // Source tag for mergeByAuthority()
        const tagged = prices.map((price) => ({ ...price, provider: providerName }));
        tagged.provider = providerName;

        const hasTomorrow = this.coversTomorrow(tagged, periods, priceInterval);
        if (hasTomorrow) {
          if (logger) logger(`Got tomorrow's prices from ${providerName}`);
          // No deferredUntil: these prices cover tomorrow, so every deferred provider would be skipped.
          return { prices: tagged, deferredUntil: null, called };
        }

        // The prices that reach furthest (a tie: the higher ranking provider)
        if (!newMarketPrices || tagged[tagged.length - 1].time > newMarketPrices[newMarketPrices.length - 1].time) {
          newMarketPrices = tagged;
        }
        if (logger) logger(`${providerName} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err;
        // 304 on revalidation: nothing changed for this provider; the loop continues.
        if (err.notModified) {
          this.registerCall(callState, provider, true, Date.now());
          if (logger) logger(`${providerName}: prices unchanged since last fetch`);
          continue;
        }
        // Only a failing API call triggers backoff, not rejected content.
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
