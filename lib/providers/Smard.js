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

// SMARD is the German regulator's (Bundesnetzagentur) market data platform. It is the most
// genuinely INDEPENDENT day-ahead source available to this app: it is neither the ENTSO-E
// transparency platform (Entsoe/EntsoeGruijter) nor Nord Pool, so an outage of either does not
// take it with them. Data is published under CC BY 4.0 and may be redistributed with attribution
// to "Bundesnetzagentur | SMARD.de" (https://www.smard.de/en/datennutzung).
//
// Coverage is the German market area plus its electrical neighbours - 15 zones, notably NOT
// Iberia, GB, Finland, most of Norway/Sweden, or south-east Europe. It is a backup for the zones
// it does cover, not a general replacement.

// SMARD's own numeric "filter" id per bidding zone, all under the /DE/ region path (SMARD models
// neighbouring-country prices as part of the German view, so the region segment stays 'DE' even
// for e.g. the Dutch series - using the country's own code there returns 404).
//
// This table is NOT published anywhere by SMARD; it was derived empirically (2026-09-10) by
// fetching every filter id that answered 200 and matching its series against known-good prices.
// All 15 below matched their zone EXACTLY, to the cent, over 72 hourly points: 13 against
// EntsoeGruijter, plus IT North (255) and HU (262) against api.energy-charts.info. Those two were
// cross-checked elsewhere only because EntsoeGruijter.js did not DECLARE them at the time - the
// proxy itself serves both, and they have since been added to its zone list, so either source
// works as a reference now. Re-verify with the same method before adding an id; a wrong mapping
// here silently serves another country's prices.
//
// Beware when using EntsoeGruijter as the reference: its status.json `name` labels are shifted for
// the Italian zones (it calls 10Y1001A1001A74G "Italy South" when the data is Sardinia). Match on
// the EIC code and the actual VALUES, never on that label.
const filterMap = {
  '10YDK-1--------W': 252, // DK1
  '10YDK-2--------M': 253, // DK2
  '10YFR-RTE------C': 254, // FR
  '10Y1001A1001A73I': 255, // IT North
  '10YNL----------L': 256, // NL
  '10YPL-AREA-----S': 257, // PL
  '10Y1001A1001A47J': 258, // SE4
  '10YCH-SWISSGRIDZ': 259, // CH
  '10YSI-ELES-----O': 260, // SI
  '10YCZ-CEPS-----N': 261, // CZ
  '10YHU-MAVIR----U': 262, // HU
  '10Y1001A1001A82H': 4169, // DE-LU
  '10YAT-APG------L': 4170, // AT
  '10YBE----------2': 4996, // BE
  '10YNO-2--------T': 4997, // NO2
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

// Represents a session to the SMARD.de (Bundesnetzagentur) chart_data API.
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

  // A government platform serving static JSON from a CDN, so it is cheap to call - but it is a
  // backup source that only gets called when the ENTSOE providers could not deliver, so there is
  // no value in revalidating prices it already agrees on.
  getRateLimit() {
    return { ...super.getRateLimit(), revalidateInterval: 0 };
  }

  /**
  * Get the prices
  * @returns {(Promise.[priceInfo])}
  * @property {string} [biddingZone] - e.g. '10YNL----------L'
  * @property {string} [dateStart = today] - date Object or date string
  * @property {string} [dateEnd = tomorrow ] - date Object or date string
  * @property {string} [resolution] - 'PT15M', 'PT30M' or 'PT60M'
  */
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
    // SMARD publishes a quarterhour and an hour series. Ask for quarterhour whenever anything
    // finer than an hour is wanted and fold it down afterwards, so PT30M is served too.
    const res = resolution === 'PT60M' ? 'hour' : 'quarterhour';

    // The index lists the start timestamp of every available week. A window can straddle two of
    // them (a request spanning a Sunday/Monday boundary), so fetch every week it touches.
    const index = await this._fetchJson(`/app/chart_data/${filter}/DE/index_${res}.json`);
    const weeks = (index && index.timestamps) || [];
    if (!weeks.length) throw Error('SMARD returned no available periods');

    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const needed = weeks.filter((w) => w <= end.getTime() && (w + WEEK) > start.getTime());
    // Always keep the newest week: tomorrow's prices live there and it is the one that matters
    // most, even when the requested window nominally ends inside the previous one.
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
          // SMARD pads the full week with nulls for periods that are not published yet
          if (price !== null && price !== undefined && !Number.isNaN(Number(price))) {
            prices.push({ time: new Date(time), price: Number(price) });
          }
        }
      } catch (err) {
        fetchError = err; // a single week may legitimately be missing; only fail if nothing lands
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
