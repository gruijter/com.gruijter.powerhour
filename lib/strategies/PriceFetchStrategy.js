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
  '10YNO-1--------2', '10YNO-2--------T', '10YNO-3--------J', '10YNO-4--------9', '10Y1001A1001A48H',
  '10Y1001A1001A44P', '10Y1001A1001A45N', '10Y1001A1001A46L', '10Y1001A1001A47J',
  '10YDK-1--------W', '10YDK-2--------M',
  '10YFI-1--------U',
  '10Y1001A1001A39I',
  '10YLV-1001A00074',
  '10YLT-1001A0008Q',
];

const SPREAD_THRESHOLD = 10 * 60 * 1000;
const BASE_BACKOFF = 15 * 60 * 1000;

const MARKET_DAY_TOLERANCE = 60 * 60 * 1000;

class PriceFetchStrategy {

  static isNordpoolZone(biddingZone) {
    return biddingZone && nordpoolZones.includes(biddingZone);
  }

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
    if (providerName === 'OMIE') return 1;
    if (isEntsoe) return 2;
    if (providerName === 'SMARD') return 3;
    if (providerName === 'Nordpool') return 4;
    return 5;
  }

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

  static sortProviders(providers, isNordpoolZone) {
    const getWeight = (name) => {
      if (isNordpoolZone) {
        if (name === 'Nordpool') return 1;
        if (name === 'ENTSOE_GRUIJTER') return 2;
        if (name === 'ENTSOE') return 3;
        if (name === 'SMARD') return 4;
        return 5;
      }
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

  static getRateLimit(provider) {
    const declared = (provider && typeof provider.getRateLimit === 'function') ? provider.getRateLimit() : {};
    return { ...DEFAULT_RATE_LIMIT, ...declared };
  }

  static needsSpreading(provider) {
    return this.getRateLimit(provider).maxRandomDelay >= SPREAD_THRESHOLD;
  }

  static getFetchDelay(providers) {
    const direct = (providers || []).filter((provider) => !this.needsSpreading(provider));
    const maxDelay = direct.length > 0 ? this.getRateLimit(direct[0]).maxRandomDelay : 5 * 60 * 1000;
    return Math.random() * maxDelay;
  }

  static canImprove(storedPrices, providerName, periods, isNordpoolZone, priceInterval, preferred) {
    if (!Array.isArray(storedPrices) || storedPrices.length === 0) return true;

    const start = periods.todayStart.getTime();
    const end = periods.tomorrowEnd.getTime();
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

  static needsRevalidation(callState, provider, now) {
    const { revalidateInterval } = this.getRateLimit(provider);
    if (!revalidateInterval) return false;
    const state = callState.get(provider.constructor.name);
    if (!state || !state.lastSuccess) return true;
    return (now - state.lastSuccess) >= revalidateInterval;
  }

  static registerCall(callState, provider, success, now, validated = success) {
    const { name } = provider.constructor;
    const { minInterval, maxBackoff } = this.getRateLimit(provider);
    const state = callState.get(name) || { failures: 0, nextAllowed: 0, spreadReserved: false };
    state.spreadReserved = false;
    if (success) {
      state.failures = 0;
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

      if (hour >= 13) {
        return { minutes: 10, reason: 'Missing tomorrow market prices after 13:00' };
      }
      if (hour >= 10 && (isNordpoolZone || hasNordpool)) {
        return { minutes: 15, reason: 'Missing tomorrow market prices (Nordpool available) after 10:00' };
      }
    }

    return null;
  }

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
        this.registerCall(callState, provider, true, Date.now(), false);
        await validator(prices);
        this.registerCall(callState, provider, true, Date.now());

        const tagged = prices.map((price) => ({ ...price, provider: providerName }));
        tagged.provider = providerName;

        const hasTomorrow = this.coversTomorrow(tagged, periods, priceInterval);
        if (hasTomorrow) {
          if (logger) logger(`Got tomorrow's prices from ${providerName}`);
          return { prices: tagged, deferredUntil: null, called };
        }

        if (!newMarketPrices || tagged[tagged.length - 1].time > newMarketPrices[newMarketPrices.length - 1].time) {
          newMarketPrices = tagged;
        }
        if (logger) logger(`${providerName} has no prices for tomorrow yet. Trying next...`);
      } catch (err) {
        if (err.message === 'Session changed') throw err;
        if (err.notModified) {
          this.registerCall(callState, provider, true, Date.now());
          if (logger) logger(`${providerName}: prices unchanged since last fetch`);
          continue;
        }
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
