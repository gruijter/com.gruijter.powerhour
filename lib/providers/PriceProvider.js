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
 * Base class for Price Providers
 */
class PriceProvider {
  constructor(options = {}) {
    this.name = this.constructor.name;
    this.options = options;
  }

  /**
   * Get bidding zones supported by this provider
   * @returns {object} Map of bidding zones
   */
  getBiddingZones() {
    return {};
  }

  /**
   * Get rate limit settings for this provider. All values in milliseconds.
   * minDelay: Minimum time to wait before fetching.
   * maxRandomDelay: Random time window added to minDelay, to spread calls of all Homeys over time.
   *   Providers declaring a large window (see PriceFetchStrategy.needsSpreading) are not called
   *   straight away, but get their own random moment within the window.
   * minInterval: Minimum time between two calls to this provider.
   * maxBackoff: Upper limit of the exponential backoff applied after failed calls.
   * revalidateInterval: How often this provider may re-check prices it already fully covers, to
   *   pick up corrections. 0 disables it, which is the default: only providers that are cheap to
   *   call should revalidate.
   * @returns {object} { minDelay, maxRandomDelay, minInterval, maxBackoff, revalidateInterval }
   */
  getRateLimit() {
    return {
      minDelay: 30000, maxRandomDelay: 300000, minInterval: 5 * 60 * 1000, maxBackoff: 2 * 60 * 60 * 1000, revalidateInterval: 0,
    };
  }

  /**
   * Fetch prices for a given period
   * @param {object} options
   * @param {string} [options.biddingZone]
   * @param {Date} [options.dateStart]
   * @param {Date} [options.dateEnd]
   * @param {string} [options.resolution]
   * @param {boolean} [options.forecast]
   * @returns {Promise<object[]>} Array of {time: Date, price: number}
   */
  async getPrices(options) {
    throw new Error('getPrices must be implemented by subclass');
  }
}

module.exports = PriceProvider;
