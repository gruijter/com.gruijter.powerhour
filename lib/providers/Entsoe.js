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

const parseXml = require('xml-js');
const PriceProvider = require('./PriceProvider');

const defaultHost = 'web-api.tp.entsoe.eu';
const defaultTimeout = 30000;

const regexReasonCode = /<code>(.*)<\/code>/;
const regexText = /<text>(.*)<\/text>/;

const biddingZones = {
  AL_Albania: '10YAL-KESH-----5',
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  BG_Bulgaria: '10YCA-BULGARIA-R',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CR_Croatia: '10YHR-HEP------M',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DE_Germany: '10Y1001A1001A83F',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark: '10Y1001A1001A65H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  DK_Denmark_Energinet: '10Y1001A1001A796',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  GB_United_Kingdom: '10Y1001A1001A92E',
  GB_United_Kingdom_National_Grid: '10YGB----------A',
  GB_United_Kingdom_NIE_SONI: '10Y1001A1001A016',
  GR_Greece: '10YGR-HTSO-----Y',
  HU_Hungary: '10YHU-MAVIR----U',
  IE_Ireland_EirGrid: '10YIE-1001A00010',
  IS_Iceland: 'IS',
  IT_Italy: '10YIT-GRTN-----B',
  IT_Italy_Calabria: '10Y1001C--00096J',
  IT_Italy_Center_South: '10Y1001A1001A71M',
  IT_Italy_Centre_North: '10Y1001A1001A70O',
  IT_Italy_Macrozone_North: '10Y1001A1001A84D',
  IT_Italy_Macrozone_South: '10Y1001A1001A85B',
  IT_Italy_North: '10Y1001A1001A73I',
  IT_Italy_Saco_AC: '10Y1001A1001A885',
  IT_Italy_Saco_DC: '10Y1001A1001A893',
  IT_Italy_Sardinia: '10Y1001A1001A74G',
  IT_Italy_Sicily: '10Y1001A1001A75E',
  IT_Italy_South: '10Y1001A1001A788',
  LT_Lithuania: '10YLT-1001A0008Q',
  LU_Luxemburg_CREOS: '10YLU-CEGEDEL-NQ',
  LU_Luxemburg_DE_LU: '10Y1001A1001A82H',
  LV_Latvia: '10YLV-1001A00074',
  MK_North_Macedonia: '10YMK-MEPSO----8',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_1: '10YNO-1--------2',
  NO_Norway_2: '10YNO-2--------T',
  NO_Norway_2NSL: '50Y0JVU59B4JWQCU',
  NO_Norway_3: '10YNO-3--------J',
  NO_Norway_4: '10YNO-4--------9',
  NO_Norway_5: '10Y1001A1001A48H',
  NO_Norway_Stattnet: '10YNO-0--------C',
  PL_Poland_PL_CZ: '10YDOM-1001A082L',
  PL_Poland_PSE: '10YPL-AREA-----S',
  PT_Portugal: '10YPT-REN------W',
  RO_Romania: '10YRO-TEL------P',
  RS_Serbia: '10YCS-SERBIATSOV',
  RU_Russia: 'RU',
  RU_Russia_EMS: '10Y1001A1001A49F',
  RU_Russia_Kaliningrad: '10Y1001A1001A50U',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
  SI_Slovenia: '10YSI-ELES-----O',
  SK_Slovakia_SEPS: '10YSK-SEPS-----K',
  TR_Turkey_TEIAS: '10YTR-TEIAS----W',
  UA_Ukaine_BEI: '10YUA-WEPS-----0',
  UA_Ukaine_DobTPP: '10Y1001A1001A869',
  UA_Ukaine_IPS: '10Y1001C--000182',
  UA_Ukraine: '10Y1001C--00003F',
  ZZ_CWE_Region: '10YDOM-REGION-1V',
};

class ENTSOE extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.apiKey = options.apiKey;
    this.biddingZone = options.biddingZone;
    this.resolution = options.resolution || 'PT15M'; // 'PT15M', 'PT30M' or 'PT60M'
    this.lastResponse = undefined;
  }

  getBiddingZones() {
    return biddingZones;
  }

  async getPrices(options) {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const opts = options || {};
    const zone = opts.biddingZone || this.biddingZone;
    const start = opts.dateStart ? new Date(opts.dateStart) : today;
    const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
    let resolution = opts.resolution || this.resolution;
    if (resolution === 'PT60M') resolution = 'PT15M';

    start.setMinutes(0, 0, 0);
    end.setMinutes(0, 0, 0);

    let interval = 60;
    if (resolution === 'PT15M') interval = 15;
    if (resolution === 'PT30M') interval = 30;

    const periodStart = start.toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const periodEnd = end.toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const path = `/api?securityToken=${this.apiKey}&documentType=A44&in_Domain=${zone}&out_Domain=${zone}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
    const res = await this._makeRequest(path);

    const tsArr = [].concat(res.Publication_MarketDocument?.TimeSeries || []);
    const filtered = tsArr.filter((s) => s.Period.resolution._text === resolution);

    let prices = [];
    for (const s of filtered) {
      const period = s.Period;
      const startDate = new Date(period.timeInterval.start._text);
      for (const p of [].concat(period.Point || [])) {
        const pos = Number(p.position._text) - 1;
        const time = new Date(startDate.getTime() + pos * interval * 60000);
        // remove double timestamps resulting from mRID duplicates
        if (!prices.some((entry) => entry.time.getTime() === time.getTime())) {
          prices.push({
            time,
            price: Number(p['price.amount']._text),
          });
        }
      }
    }
    prices = prices.filter((p) => p.time >= start && p.time <= end).sort((a, b) => a.time - b.time);

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

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      // find errors
      if (result.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      const body = await result.text();
      this.lastResponse = body || result.status;
      if (body && (body.includes('<!doctype html>') || body.includes('Transparency Platform'))) {
        throw new Error('ENTSO-E Service Temporarily Unavailable');
      }
      if (body && body.includes('<Reason>')) {
        const code = regexReasonCode.exec(body); // 999 = error?
        const text = regexText.exec(body); // error tekst
        if (code && code[1]) throw Error(`${code[1]} ${text ? text[1] : ''}`);
      }
      const contentType = result.headers.get('content-type');
      if (!/\/xml/.test(contentType)) {
        throw Error(`Expected xml but received ${contentType}: ${body}`);
      }
      if (result.status !== 200) {
        this.lastResponse = result.status;
        throw Error(`HTTP request Failed. Status Code: ${result.status}`);
      }
      // parse xml to json object
      const parseOptions = {
        compact: true, nativeType: true, ignoreDeclaration: true, ignoreAttributes: true, // spaces: 2,
      };
      const json = parseXml.xml2js(body, parseOptions);
      return json;
    } catch (error) {
      this.lastResponse = error;
      throw error;
    }
  }
}

module.exports = ENTSOE;
