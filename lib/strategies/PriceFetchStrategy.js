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

// How far the fetched prices may fall short of the end of tomorrow while still counting as
// complete. It exists because the delivery day of a bidding zone need not line up with the civil
// day of the Homey asking for it: the periods come from homey.clock (TimeHelpers.getUTCPeriods),
// the market day from the zone. MIBEL (PT) and SEM (IE) trade on a CET day, so a Lisbon Homey on
// WET never sees the last hour of its own civil day; the mirror case is a CET Homey configured for
// an EET zone. Both directions occur - a Homey can be anywhere relative to the zone it is set to -
// and every pair in the current zone list is off by at most one hour.
// Deliberately NOT a per-zone market-timezone table: that would need an entry for all ~47 zones
// (the Homey's own timezone cannot serve as the default) and this codebase has been bitten more
// than once by hardcoded zone maps going stale.
// Widen to 2h only if a WET Homey ever has to serve an EET zone. The price of the tolerance is
// that a zone which genuinely published one hour short is accepted as complete, and the remaining
// providers are not asked.
const MARKET_DAY_TOLERANCE = 60 * 60 * 1000;

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
      if (providerName === 'SMARD') return 3;
      return 4;
    }
    // OMIE is the NEMO that runs the Iberian day-ahead auction, so for ES/PT it is the primary
    // source and ENTSO-E is the republisher - the same relationship Nordpool has in its own zones.
    // Unconditional rank 1 is safe because OMIE declares only ES/PT and the device filters
    // providers to those supporting its zone, so it can never appear outside Iberia.
    if (providerName === 'OMIE') return 1;
    if (isEntsoe) return 2;
    // SMARD ranks directly above Nordpool: it is the Bundesnetzagentur's own publication, so it
    // outranks the scraped secondaries, but it stays below ENTSOE, which remains the reference.
    // In a Nordpool zone Nordpool keeps its promotion to rank 1 and SMARD slots in below ENTSOE.
    if (providerName === 'SMARD') return 3;
    if (providerName === 'Nordpool') return 4;
    return 5;
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
        if (name === 'SMARD') return 4;
        return 5;
      }
      // Deprioritize Nordpool for other zones (e.g. NL, DE) to avoid incorrect prices during market decoupling,
      // but keep it above the scraped secondary sources (e.g. Stekker).
      // Prefer EntsoeGruijter (fast/proxy) over Entsoe (slow/direct)
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
    // Discounted by MARKET_DAY_TOLERANCE for the same reason as coversTomorrow(): on a zone whose
    // market day is offset from the Homey's civil day the stored prices can never reach the full
    // count, and without this every provider would be called again on every single cycle forever.
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
   * Compares the END of the last interval (price.time is its start) against tomorrowEnd, so the
   * test scales with priceInterval by itself. The fixed one-hour margin this replaces left exactly
   * zero slack on PT60M and was 45 minutes too generous on PT15M.
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
   * Give a provider with a large spread window its own random moment within that window.
   * Returns the reserved timestamp on the first encounter, and null once that moment has been
   * reserved, so the next attempt actually calls the provider.
   */
  /**
   * Hand back a spread reservation for a provider that ended up not being called after all.
   * reserveSpread() marks the provider as reserved and only registerCall() clears that mark, so a
   * provider that is reserved and then skipped (canImprove() turned false while it waited) would
   * keep the mark forever: on its next encounter reserveSpread() returns null straight away and the
   * provider is called at the very top of the hour, together with every other Homey - exactly what
   * the spread exists to prevent. nextAllowed is deliberately left in place; it still holds the
   * reserved moment, which remains a perfectly good time to call this provider.
   */
  static releaseSpread(callState, provider) {
    const state = callState.get(provider.constructor.name);
    if (state && state.spreadReserved) {
      state.spreadReserved = false;
      callState.set(provider.constructor.name, state);
    }
  }

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
   * Best (lowest) rank present in the stored prices for today and tomorrow, or 99 when there are
   * none. Only a provider that ranks at least as high may usefully revalidate: prices of a lower
   * ranking provider would be discarded by mergeByAuthority() anyway.
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
   * Check whether a provider should re-fetch prices it already fully covers, to pick up
   * corrections. Only providers that declare a revalidateInterval do this. After a restart there is
   * no last success yet, so one revalidation is allowed to re-establish the state.
   */
  static needsRevalidation(callState, provider, now) {
    const { revalidateInterval } = this.getRateLimit(provider);
    if (!revalidateInterval) return false;
    const state = callState.get(provider.constructor.name);
    if (!state || !state.lastSuccess) return true;
    return (now - state.lastSuccess) >= revalidateInterval;
  }

  /**
   * Record the result of a call. A successful call is followed by the provider's minimum interval,
   * a failed call by an exponential backoff, so a provider that is down is not hammered.
   */
  static registerCall(callState, provider, success, now, validated = success) {
    const { name } = provider.constructor;
    const { minInterval, maxBackoff } = this.getRateLimit(provider);
    const state = callState.get(name) || { failures: 0, nextAllowed: 0, spreadReserved: false };
    state.spreadReserved = false;
    if (success) {
      state.failures = 0;
      // `success` means the API answered, which is what the backoff cares about. `validated` means
      // it answered with USABLE prices, which is what needsRevalidation() cares about - a provider
      // that returns 200 with a stale or short document must not consume its revalidation window.
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
    const nowBrussels = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));

    // Before 10:00, no new prices are available anywhere
    if (hasToday && nowBrussels.getHours() < 10) {
      return { skip: true, reason: 'Too early (before 10:00)' };
    }

    // Everything else is decided per provider in the fetch loop: canImprove() skips providers that
    // cannot add anything, and needsRevalidation() lets a cheap provider check for corrections.
    return { skip: false };
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
        // The API answered: clear the backoff and apply the minimum interval, but do not yet count
        // this as the successful fetch that needsRevalidation() measures from - see below.
        this.registerCall(callState, provider, true, Date.now(), false);
        await validator(prices); // Should throw if invalid or session changed
        // Content is usable, so this is a real success for revalidation purposes too.
        this.registerCall(callState, provider, true, Date.now());

        // Tag every price with its source, so mergeByAuthority() can protect it later on
        const tagged = prices.map((price) => ({ ...price, provider: providerName }));
        tagged.provider = providerName;

        const hasTomorrow = this.coversTomorrow(tagged, periods, priceInterval);
        if (hasTomorrow) {
          if (logger) logger(`Got tomorrow's prices from ${providerName}`);
          // deferredUntil is dropped: it only records providers worth coming back for, and the
          // returned prices already cover through tomorrowEnd, so every deferred provider would be
          // skipped by canImprove() on the retry. Reporting it would arm a full fetch cycle that
          // can only conclude there is nothing to do.
          return { prices: tagged, deferredUntil: null, called };
        }

        // Keep the prices that extend furthest into the future (on a tie the higher ranking provider wins)
        if (!newMarketPrices || tagged[tagged.length - 1].time > newMarketPrices[newMarketPrices.length - 1].time) {
          newMarketPrices = tagged;
        }
        if (logger) logger(`${providerName} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err; // Abort immediately
        // A conditional revalidation that returns 304: the API answered fine and nothing changed,
        // so there is nothing to do for THIS provider. The loop still continues - a 304 only speaks
        // for the provider that sent it. In practice the remaining providers are skipped by
        // canImprove() for the same reason this one revalidated, but that is their decision to
        // make, not something a 304 may assume on their behalf.
        if (err.notModified) {
          this.registerCall(callState, provider, true, Date.now());
          if (logger) logger(`${providerName}: prices unchanged since last fetch`);
          continue;
        }
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
