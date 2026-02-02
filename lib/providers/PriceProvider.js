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
