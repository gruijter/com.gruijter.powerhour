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

const PriceProvider = require('./PriceProvider');

const defaultHost = 'www.smard.de';
const defaultTimeout = 30000;

const filterMap = {
  '10YDK-1--------W': 252,
  '10YDK-2--------M': 253,
  '10YFR-RTE------C': 254,
  '10Y1001A1001A73I': 255,
  '10YNL----------L': 256,
  '10YPL-AREA-----S': 257,
  '10Y1001A1001A47J': 258,
  '10YCH-SWISSGRIDZ': 259,
  '10YSI-ELES-----O': 260,
  '10YCZ-CEPS-----N': 261,
  '10YHU-MAVIR----U': 262,
  '10Y1001A1001A82H': 4169,
  '10YAT-APG------L': 4170,
  '10YBE----------2': 4996,
  '10YNO-2--------T': 4997,
};

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  FR_France: '10YFR-RTE------C',
  HU_Hungary: '10YHU-MAVIR----U',
  IT_Italy_North: '10Y1001A1001A73I',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_2: '10YNO-2--------T',
  PL_Poland_PSE: '10YPL-AREA-----S',
  SE_Sweden_4: '10Y1001A1001A47J',
  SI_Slovenia: '10YSI-ELES-----O',
};

class SMARD extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.biddingZone = options.biddingZone;
    this.biddingZones = biddingZones;
  }

  getBiddingZones() {
    return this.biddingZones;
  }

  getRateLimit() {
    return { ...super.getRateLimit(), revalidateInterval: 0 };
  }

  async getPrices(options) {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const opts = options || {};
    const zone = opts.biddingZone || this.biddingZone;
    const start = opts.dateStart ? new Date(opts.dateStart) : today;
    const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;

    const filter = filterMap[zone];
    if (!filter) throw Error(`Zone ${zone} not supported by SMARD`);

    const resolution = opts.resolution === 'PT15M' ? 'PT15M' : (opts.resolution || 'PT60M');
    const res = resolution === 'PT60M' ? 'hour' : 'quarterhour';

    const index = await this._fetchJson(`/app/chart_data/${filter}/DE/index_${res}.json`);
    const weeks = (index && index.timestamps) || [];
    if (!weeks.length) throw Error('SMARD returned no available periods');

    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const needed = weeks.filter((w) => w <= end.getTime() && (w + WEEK) > start.getTime());
    if (!needed.includes(weeks[weeks.length - 1]) && weeks[weeks.length - 1] <= end.getTime()) {
      needed.push(weeks[weeks.length - 1]);
    }
    if (!needed.length) needed.push(weeks[weeks.length - 1]);

    let prices = [];
    let fetchError;
    for (const week of needed) {
      try {
        const data = await this._fetchJson(`/app/chart_data/${filter}/DE/${filter}_DE_${res}_${week}.json`);
        for (const [time, price] of (data && data.series) || []) {
          if (price !== null && price !== undefined && !Number.isNaN(Number(price))) {
            prices.push({ time: new Date(time), price: Number(price) });
          }
        }
      } catch (err) {
        fetchError = err;
      }
    }

    prices = prices
      .filter((p) => p.time >= start && p.time <= end)
      .sort((a, b) => a.time - b.time);

    if (prices.length === 0) {
      if (fetchError) throw fetchError;
      throw Error('No prices found');
    }

    if (resolution === 'PT15M') {
      const hasSubHourly = prices.some((p, i) => i > 0 && (p.time - prices[i - 1].time) < 3600000);
      if (!hasSubHourly) throw Error('No 15m resolution available');
    }
    if (resolution === 'PT30M') {
      const hasSubHourly = prices.some((p, i) => i > 0 && (p.time - prices[i - 1].time) < 3600000);
      if (!hasSubHourly) throw Error('No 30m resolution available');
      const hasSub30m = prices.some((p, i) => i > 0 && (p.time - prices[i - 1].time) < 1800000);
      if (hasSub30m) prices = PriceProvider.aggregateTo(prices, 30);
    }
    if (resolution === 'PT60M') prices = PriceProvider.aggregateTo(prices, 60);

    return prices;
  }

  async _fetchJson(path) {
    const res = await fetch(`https://${this.host}${path}`, {
      headers: { Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw Error(`SMARD API error ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text || !text.trim()) throw Error('SMARD returned an empty response');
    return JSON.parse(text);
  }

}

module.exports = SMARD;
