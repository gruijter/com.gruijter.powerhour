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

const defaultHost = 'entsoe-prices.gruijter.org';
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
class ENTSOE_GRUIJTER extends PriceProvider {

  constructor(opts) {
    super(opts);
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
   * EntsoeGruijter Proxy.
   * Based on Cloudflare R2 with 5 minute CDN buffering.
   * Uses a 5-minute spread to avoid overloading the proxy server.
   */
  getRateLimit() {
    return { minDelay: 30000, maxRandomDelay: 300000 };
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

    const path = `/${zone}.json`;
    const res = await this._makeRequest(path);

    if (!res?.data) throw Error('contains no prices data');
    if (resolution === 'PT60M' && res.res === '15m') resolution = 'PT15M';
    if (resolution === 'PT30M' && res.res === '15m') resolution = 'PT15M';
    if (resolution === 'PT30M' && res.res !== '30m' && res.res !== '15m') throw Error('No 30m resolution available');
    if (resolution === 'PT15M' && res.res !== '15m') throw Error('No 15m resolution available');

    let prices = res.data
      .map((item) => ({ ...item, time: new Date(item.time) }))
      .filter((p) => p.time >= start && p.time <= end).sort((a, b) => a.time - b.time);

    // If resolution is PT30M, average prices per 30m
    if (opts.resolution === 'PT30M') {
      const halfHourlyMap = new Map();
      for (const entry of prices) {
        const hour = new Date(entry.time);
        const mins = hour.getMinutes();
        hour.setMinutes(mins < 30 ? 0 : 30, 0, 0);
        const key = hour.getTime();
        if (!halfHourlyMap.has(key)) halfHourlyMap.set(key, []);
        halfHourlyMap.get(key).push(entry.price);
      }
      prices = Array.from(halfHourlyMap.entries()).map(([time, priceArr]) => ({
        time: new Date(Number(time)),
        price: priceArr.reduce((a, b) => a + b, 0) / priceArr.length,
      }));
      prices.sort((a, b) => a.time - b.time);
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

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      if (result.status === 404) throw Error(`Zone not found: ${actionPath}`);

      // find errors
      const body = await result.text();
      this.lastResponse = body || result.status;
      const contentType = result.headers.get('content-type');
      if (!/\/json/.test(contentType)) {
        throw Error(`Expected JSON but received ${contentType}: ${body.slice(0, 100)}`);
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
