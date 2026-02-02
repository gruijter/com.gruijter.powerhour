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
