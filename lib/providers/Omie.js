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

// OMIE is the Nominated Electricity Market Operator (NEMO) that RUNS the Iberian (MIBEL)
// day-ahead auction for Spain and Portugal. It is therefore the PRIMARY source for these two
// zones - ENTSO-E republishes what is submitted to it, the same relationship Nord Pool has in
// the Nordic zones (where this app already ranks Nordpool first). Hence OMIE outranks the ENTSOE
// providers for ES/PT in PriceFetchStrategy.
//
// This is not merely a redundancy win. ENTSO-E's SPANISH series does not agree with OMIE at any
// resolution - measured 2026-09-10/11 over today+tomorrow: Portugal matched 192/192 at PT15M and
// 24/24 at PT60M, while Spain matched 0/24 through the identical code path. OMIE also reports
// ES == PT in 180 of 192 periods, which is the expected shape for MIBEL (the two zones decouple
// only when the interconnector congests); ENTSO-E reporting them different in ~90% of periods is
// not physically plausible there. The cause upstream is unidentified, so treat this comment as
// what was measured, not as a diagnosis.
//
// Deliberately NOT used: REE/ESIOS PVPC. That is the regulated Spanish end-user tariff and
// already includes servicios de ajuste, renewable-subsidy financing and network components.
// This app's model (see PriceCalculator.calculateMarkupPrices) takes a BARE wholesale price and
// has the user add markup/VAT/TOD on top, so a PVPC feed would double-count against their own
// settings. OMIE's marginal price is the right shape; PVPC is not.

// Spain AND Portugal. OMIE runs the single MIBEL auction that clears both zones, so it is the
// primary source for each of them.
//
// Note on the delivery day, because it looks like a bug and is not: MIBEL's delivery day is
// CET-aligned for BOTH zones, even though Lisbon's civil time is WET (one hour behind Madrid).
// Verified against ENTSO-E, which publishes the Portuguese zone on exactly the same boundaries -
// first point 22:00Z, last 21:00Z, i.e. the Spanish day - not on Lisbon civil midnight.
//
// The consequence is that a window built from Lisbon CIVIL midnights (as getUTCPeriods does for a
// Portuguese Homey) runs one hour past the last auctioned hour, so PriceFetchStrategy's
// hasTomorrow test cannot pass for Portugal. That is a pre-existing app-level characteristic of
// how the Portuguese day is framed, NOT a limitation of this provider: measured over an identical
// Lisbon window, EntsoeGruijter returns the same 23 hours with the same last point (21:00Z) and
// the same hasTomorrow=false. Nobody publishes that hour, because it belongs to the next MIBEL
// delivery day, which has not been auctioned yet. Do not "fix" this by dropping Portugal - OMIE is
// exactly as complete as every other source for it.
const biddingZones = {
  ES_Spain: '10YES-REE------0',
  PT_Portugal: '10YPT-REN------W',
};

// Column index within a marginalpdbc row: year;month;day;period;pricePT;priceES;
// Confirmed against OMIE's OWN labelled daily averages rather than inferred: for 2026-09-11 the
// omie.es front page published "España 144,50" and "Portugal 144,72", and the two columns average
// 144.50 and 144.72 respectively - exact to the cent. Do not reorder these on a hunch.
const zoneColumn = {
  '10YPT-REN------W': 4, // Portugal
  '10YES-REE------0': 5, // Spain
};

// Periods are numbered from LOCAL IBERIAN midnight, sequentially in real time, and OMIE (a
// Spanish operator) stamps both columns on Spanish local time - including the Portuguese one,
// which sits in a different timezone (WET) in real life. Verified: converting with Europe/Madrid
// reproduced ENTSO-E's Portuguese series exactly, so do not apply WET to the PT column.
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

  // Static files off a public web server, cheap to call. No revalidation: OMIE publishes a day's
  // file once and does not restate it, so re-fetching a day we already hold buys nothing.
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

    // One file per calendar day, named by the LOCAL Iberian date. Walk local days, not UTC days,
    // or the first/last file of a range is missed whenever the UTC and local dates differ.
    let prices = [];
    let fetchError;
    const loop = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    while (loop <= end) {
      const localMidnight = TimeHelpers.getLocalMidnightUTC(loop, MARKET_TIMEZONE);
      const label = new Date(loop.toLocaleString('en-US', { timeZone: MARKET_TIMEZONE }));
      const stamp = `${label.getFullYear()}${String(label.getMonth() + 1).padStart(2, '0')}${String(label.getDate()).padStart(2, '0')}`;
      try {
        const rows = await this._fetchDay(stamp);
        for (const cells of rows) {
          const period = Number(cells[3]);
          const price = Number(cells[col]);
          if (!Number.isFinite(period) || period < 1 || !Number.isFinite(price)) continue;
          // Periods run sequentially in REAL time from local midnight, so a DST day simply has
          // 92 or 100 of them. Adding elapsed time (rather than wall-clock slots) stays correct
          // across both transitions without special-casing either.
          prices.push({ time: new Date(localMidnight.getTime() + (period - 1) * 15 * 60000), price });
        }
      } catch (err) {
        fetchError = err; // a future/missing day is normal; only fail if nothing lands at all
      }
      loop.setDate(loop.getDate() + 1);
    }

    // De-duplicate: consecutive local days can overlap after the DST fall-back hour
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

    // The feed is natively quarter-hourly, so PT15M needs no work and the coarser resolutions are
    // plain averages.
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
