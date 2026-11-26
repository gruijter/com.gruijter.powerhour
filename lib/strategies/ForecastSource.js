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

const Stekker = require('../providers/Stekker');
const EpexPredictor = require('../providers/EpexPredictor');
const EnergyForecast = require('../providers/EnergyForecast');
const EnergyPriceForecast = require('../providers/EnergyPriceForecast');
const PriceProvider = require('../providers/PriceProvider');

const PROVIDERS = {
  EpexPredictor, EnergyPriceForecast, EnergyForecast, Stekker,
};
const AUTO_ORDER = ['EpexPredictor', 'EnergyPriceForecast', 'EnergyForecast', 'Stekker'];

const hasZone = (Provider, biddingZone) => {
  const zones = new Provider().getBiddingZones();
  return Object.keys(zones).some((key) => zones[key].includes(biddingZone));
};

class ForecastSource {

  constructor({ choice, apiKey, biddingZone }) {
    const names = PROVIDERS[choice] ? [choice, ...AUTO_ORDER.filter((n) => n !== choice)] : AUTO_ORDER;
    this.providers = names
      .filter((name) => hasZone(PROVIDERS[name], biddingZone))
      .filter((name) => name !== 'EnergyForecast' || (apiKey && apiKey.trim()))
      .map((name) => new PROVIDERS[name]({ biddingZone, apiKey }));
    this.cache = new Map();
    this.lastName = null;
  }

  get name() {
    return this.lastName || (this.providers[0] ? this.providers[0].constructor.name : '');
  }

  get available() {
    return this.providers.length > 0;
  }

  async getPrices({ resolution }, log = () => {}) {
    for (const provider of this.providers) {
      const { name } = provider.constructor;
      const minInterval = typeof provider.getMinFetchInterval === 'function' ? provider.getMinFetchInterval() : 0;
      const cached = this.cache.get(name);
      let prices = cached && cached.resolution === resolution && Date.now() - cached.tm < minInterval ? cached.prices : null;
      if (!prices) {
        prices = await provider.getPrices({ forecast: true, resolution }).catch((err) => {
          log(`${name} forecast failed: ${err.message}`);
          return null;
        });
        if (prices && prices.length && resolution === 'PT60M' && prices.length > 1 && prices[1].time - prices[0].time < 3600000) {
          prices = PriceProvider.aggregateTo(prices, 60);
        }
        if (prices && prices.length) this.cache.set(name, { tm: Date.now(), resolution, prices });
      }
      if (prices && prices.length) {
        this.lastName = name;
        return prices;
      }
    }
    return [];
  }
}

module.exports = ForecastSource;
module.exports.PROVIDERS = PROVIDERS;
