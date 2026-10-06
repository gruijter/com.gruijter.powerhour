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
const TimeHelpers = require('../helpers/TimeHelpers');

const defaultHost = 'www.omie.es';
const defaultTimeout = 30000;

// OMIE runs the Iberian (MIBEL) day-ahead auction: the primary source for ES/PT, ranked above
// ENTSO-E. Measured 2026-09-10/11: ENTSO-E's Spanish series did not match OMIE (0/24), Portugal
// did (cause unknown). Not REE/ESIOS PVPC: that is an end-user tariff, this app needs wholesale.

// MIBEL's delivery day is CET-aligned for both zones (verified against ENTSO-E). A Lisbon Homey's
// civil day therefore runs one hour past the last auctioned hour: no source has that hour.
const biddingZones = {
  ES_Spain: '10YES-REE------0',
  PT_Portugal: '10YPT-REN------W',
};

// Column index in a marginalpdbc row: year;month;day;period;pricePT;priceES (verified against
// OMIE's published daily averages, 2026-09-11).
const zoneColumn = {
  '10YPT-REN------W': 4, // Portugal
  '10YES-REE------0': 5, // Spain
};

// Both columns are on Spanish local time, also Portugal (verified against ENTSO-E).
const MARKET_TIMEZONE = 'Europe/Madrid';

class OMIE extends PriceProvider {

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

  // Static files, cheap. No revalidation: a day's file is not restated.
  getRateLimit() {
    return { ...super.getRateLimit(), revalidateInterval: 0 };
  }

  /**
  * Get the prices
  * @returns {(Promise.[priceInfo])}
  * @property {string} [biddingZone] - '10YES-REE------0' or '10YPT-REN------W'
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

    const col = zoneColumn[zone];
    if (col === undefined) throw Error(`Zone ${zone} not supported by OMIE`);

    const resolution = opts.resolution || 'PT60M';

    // One file per LOCAL Iberian date: walk local days, not UTC days.
    let prices = [];
    let fetchError;
    const loop = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    while (loop <= end) {
      const localMidnight = TimeHelpers.getLocalMidnightUTC(loop, MARKET_TIMEZONE);
      const label = TimeHelpers.toLocalDate(loop, MARKET_TIMEZONE);
      const stamp = `${label.getFullYear()}${String(label.getMonth() + 1).padStart(2, '0')}${String(label.getDate()).padStart(2, '0')}`;
      try {
        const rows = await this._fetchDay(stamp);
        for (const cells of rows) {
          const period = Number(cells[3]);
          const price = Number(cells[col]);
          if (!Number.isFinite(period) || period < 1 || !Number.isFinite(price)) continue;
          // Periods run in real time from local midnight (92 or 100 on a DST day).
          prices.push({ time: new Date(localMidnight.getTime() + (period - 1) * 15 * 60000), price });
        }
      } catch (err) {
        fetchError = err; // a missing future day is normal; fail only when nothing lands
      }
      loop.setDate(loop.getDate() + 1);
    }

    // Deduplicate: local days can overlap after the DST fall-back hour
    const seen = new Set();
    prices = prices
      .filter((p) => {
        const t = p.time.getTime();
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .filter((p) => p.time >= start && p.time <= end)
      .sort((a, b) => a.time - b.time);

    if (prices.length === 0) {
      if (fetchError) throw fetchError;
      throw Error('No prices found');
    }

    // Natively quarter-hourly; coarser resolutions are averages.
    if (resolution === 'PT30M') prices = PriceProvider.aggregateTo(prices, 30);
    if (resolution === 'PT60M') prices = PriceProvider.aggregateTo(prices, 60);

    return prices;
  }

  async _fetchDay(stamp) {
    const path = `/es/file-download?parents=marginalpdbc&filename=marginalpdbc_${stamp}.1`;
    const res = await fetch(`https://${this.host}${path}`, {
      headers: { Accept: 'text/plain, */*' },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw Error(`OMIE API error ${res.status} ${res.statusText}`);
    const text = await res.text();
    // A missing day is served as the site's HTML 404 page with a 200, so sniff the payload.
    if (!text || !text.trim().toUpperCase().startsWith('MARGINALPDBC')) {
      throw Error(`No OMIE prices published for ${stamp}`);
    }
    return text
      .split('\n')
      .map((line) => line.trim().split(';'))
      .filter((cells) => cells.length >= 6 && /^\d{4}$/.test(cells[0]));
  }

}

module.exports = OMIE;
