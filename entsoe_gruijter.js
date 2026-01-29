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

const defaultHost = 'entsoe.gruijter.org';
const defaultPort = 443;
const defaultTimeout = 30000;

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  BG_Bulgaria: '10YCA-BULGARIA-R',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CR_Croatia: '10YHR-HEP------M',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DE_Germany_Amprion: '10Y1001A1001A59C',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  GR_Greece: '10YGR-HTSO-----Y',
  IT_Italy_Center_South: '10Y1001A1001A71M',
  IT_Italy_Centre_North: '10Y1001A1001A70O',
  IT_Italy_Sardinia: '10Y1001A1001A74G',
  LT_Lithuania: '10YLT-1001A0008Q',
  LV_Latvia: '10YLV-1001A00074',
  ME_Montenegro: '10YCS-CG-TSO---S',
  MK_North_Macedonia: '10YMK-MEPSO----8',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_1: '10YNO-1--------2',
  NO_Norway_2: '10YNO-2--------T',
  NO_Norway_2NSL: '50Y0JVU59B4JWQCU',
  NO_Norway_3: '10YNO-3--------J',
  NO_Norway_4: '10YNO-4--------9',
  NO_Norway_5: '10Y1001A1001A48H',
  PL_Poland_PSE: '10YPL-AREA-----S',
  PT_Portugal: '10YPT-REN------W',
  RO_Romania: '10YRO-TEL------P',
  RS_Serbia: '10YCS-SERBIATSOV',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
  SI_Slovenia: '10YSI-ELES-----O',
  SK_Slovakia_SEPS: '10YSK-SEPS-----K',
  UA_Ukaine_IPS: '10Y1001C--000182',
};

// Represents a session to the ENTSOE.GRUIJTER.ORG API.
class ENTSOE_GRUIJTER {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.port = options.port || defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.apiKey = options.apiKey || '';
    this.biddingZone = options.biddingZone;
    this.resolution = options.resolution || 'PT15M'; // 'PT15M', 'PT30M' or 'PT60M'
    this.biddingZones = biddingZones;
    this.lastResponse = undefined;
  }

  getBiddingZones() {
    return this.biddingZones;
  }

  /**
  * Get the prices
  * @returns {(Promise.[priceInfo])}
  * @property {string} [biddingZone] - e.g. '10YNL----------L'
  * @property {string} [dateStart = today] - date Object or date string, e.g. '2022-02-21T20:36:10.665Z'
  * @property {string} [dateEnd = tomorrow ] - date Object or date string, e.g. '2022-02-21T20:36:10.665Z'
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
    let resolution = opts.resolution || this.resolution;
    // if (resolution === 'PT60M') resolution = 'PT15M';

    start.setMinutes(0, 0, 0);
    end.setMinutes(0, 0, 0);

    const path = `/?zone=${zone}&key=${this.apiKey}`;
    const res = await this._makeRequest(path);

    if (!res?.data) throw Error('contains no prices data');
    if (resolution === 'PT60M' && res.res === '15m') resolution = 'PT15M';
    if (resolution === 'PT30M' && res.res !== '30m') throw Error('No 30m resolution available');
    if (resolution === 'PT15M' && res.res !== '15m') throw Error('No 15m resolution available');

    let interval = 60;
    if (resolution === 'PT15M') interval = 15;
    if (resolution === 'PT30M') interval = 30;

    let prices = res.data
      .map((item) => ({ ...item, time: new Date(item.time) }))
      .filter((p) => p.time >= start && p.time <= end).sort((a, b) => a.time - b.time);

    // Pad missing intervals with previous price
    if (prices.length > 0) {
      const padded = [prices[0]];
      for (let i = 1; i < prices.length; i++) {
        let prevTime = padded[padded.length - 1].time;
        const currTime = prices[i].time;
        let diff = (currTime - prevTime) / 60000;
        while (diff > interval) {
          prevTime = new Date(prevTime.getTime() + interval * 60000);
          padded.push({ time: new Date(prevTime), price: padded[padded.length - 1].price });
          diff -= interval;
        }
        padded.push(prices[i]);
      }
      prices = padded;
    }

    // If resolution is PT60M, average prices per hour and keep only hourly timestamps
    if (opts.resolution === 'PT60M') {
      const hourlyMap = new Map();
      for (const entry of prices) {
        // Defensive: always parse to Date
        const hour = new Date(entry.time);
        if (Number.isNaN(hour)) continue; // skip invalid dates
        hour.setMinutes(0, 0, 0);
        const key = hour.getTime();
        if (!hourlyMap.has(key)) hourlyMap.set(key, []);
        hourlyMap.get(key).push(entry.price);
      }
      prices = Array.from(hourlyMap.entries()).map(([time, priceArr]) => ({
        time: new Date(Number(time)),
        price: priceArr.reduce((a, b) => a + b, 0) / priceArr.length,
      }));
      prices.sort((a, b) => a.time - b.time);
    }

    return prices;
  }

  async _makeRequest(actionPath, timeout) {
    try {
      const url = `https://${this.host}${actionPath}`;
      const options = {
        method: 'GET',
        timeout: timeout || this.timeout,
      };

      console.log(url);

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      // find errors
      const body = await result.text();
      this.lastResponse = body || result.status;
      const contentType = result.headers.get('content-type');
      if (!/\/json/.test(contentType)) {
        throw Error(`Expected JSON but received ${contentType}: ${body}`);
      }
      if (result.status !== 200) {
        this.lastResponse = result.status;
        throw Error(`HTTPS request Failed. Status Code: ${result.status}`);
      }
      return JSON.parse(body);
    } catch (error) {
      this.lastResponse = error;
      throw error;
    }
  }
}

module.exports = ENTSOE_GRUIJTER;

/*
Example and documentation:

*/

// // START TEST HERE
// // eslint-disable-next-line global-require, node/no-unpublished-require
// const apiKey = require('./env.json').ENTSOE_GRUIJTER_API_KEY;

// const Entsoe = new ENTSOE({ biddingZone: '10YAT-APG------L', apiKey }); // '10Y1001A1001A82H'

// const today = new Date();
// today.setHours(0);
// const tomorrow = new Date(today);
// tomorrow.setDate(tomorrow.getDate() + 2);

// // const today = new Date('2024-10-26T23:00:00.000Z'); // today;
// // const tomorrow = new Date('2024-10-29T23:00:00.000Z'); // tomorrow;

// Entsoe.getPrices({ dateStart: today, dateEnd: tomorrow, resolution: 'PT15M' })
//   .then((result) => console.dir(result, { depth: null }))
//   .catch((error) => console.log(error));

// Entsoe.getPrices({ dateStart: today, dateEnd: tomorrow, resolution: 'PT60M' })
//   .then((result) => console.dir(result, { depth: null }))
//   .catch((error) => console.log(error));

// definitions for JSDoc

/**
* @typedef priceInfo
* @description Array of prices with UTC timestamp
* @property {array} prices - Array with object including UTC time and price
* @example
[
  { time: 2022-12-12T23:00:00.000Z, price: 305.7 },
  { time: 2022-12-13T00:00:00.000Z, price: 287.52 },
  { time: 2022-12-13T01:00:00.000Z, price: 284.69 },
  { time: 2022-12-13T02:00:00.000Z, price: 275.83 },
  { time: 2022-12-13T03:00:00.000Z, price: 282.3 },
  { time: 2022-12-13T04:00:00.000Z, price: 316.07 },
  { time: 2022-12-13T05:00:00.000Z, price: 368.9 },
  { time: 2022-12-13T06:00:00.000Z, price: 499.7 },
  { time: 2022-12-13T07:00:00.000Z, price: 571.76 },
  { time: 2022-12-13T08:00:00.000Z, price: 553.29 },
  { time: 2022-12-13T09:00:00.000Z, price: 486.27 },
  { time: 2022-12-13T10:00:00.000Z, price: 448.9 },
  { time: 2022-12-13T11:00:00.000Z, price: 459.98 },
  { time: 2022-12-13T12:00:00.000Z, price: 506.03 },
  { time: 2022-12-13T13:00:00.000Z, price: 552.71 },
  { time: 2022-12-13T14:00:00.000Z, price: 570.25 },
  { time: 2022-12-13T15:00:00.000Z, price: 590 },
  { time: 2022-12-13T16:00:00.000Z, price: 665.01 },
  { time: 2022-12-13T17:00:00.000Z, price: 560.15 },
  { time: 2022-12-13T18:00:00.000Z, price: 516.57 },
  { time: 2022-12-13T19:00:00.000Z, price: 399.9 },
  { time: 2022-12-13T20:00:00.000Z, price: 341.44 },
  { time: 2022-12-13T21:00:00.000Z, price: 301.69 },
  { time: 2022-12-13T22:00:00.000Z, price: 283.08 }
]
*/
