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

const DEFAULT_RATE_LIMIT = {
  minDelay: 30000,
  maxRandomDelay: 5 * 60 * 1000,
  minInterval: 5 * 60 * 1000,
  maxBackoff: 2 * 60 * 60 * 1000,
  revalidateInterval: 0,
};

class PriceProvider {
  constructor(options = {}) {
    this.name = this.constructor.name;
    this.options = options;
  }

  getBiddingZones() {
    return {};
  }

  getRateLimit() {
    return { ...DEFAULT_RATE_LIMIT };
  }

  static aggregateTo(prices, minutes) {
    if (!Array.isArray(prices) || prices.length === 0) return prices;
    const buckets = new Map();
    for (const entry of prices) {
      const time = new Date(entry.time);
      if (Number.isNaN(time.getTime())) continue;
      const mins = time.getUTCMinutes();
      time.setUTCMinutes(mins - (mins % minutes), 0, 0);
      const key = time.getTime();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry.price);
    }
    return [...buckets.entries()]
      .map(([time, priceArr]) => ({
        time: new Date(Number(time)),
        price: priceArr.reduce((a, b) => a + b, 0) / priceArr.length,
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getPrices(options) {
    throw new Error('getPrices must be implemented by subclass');
  }
}

module.exports = PriceProvider;
module.exports.DEFAULT_RATE_LIMIT = DEFAULT_RATE_LIMIT;
