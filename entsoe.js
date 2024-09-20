/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

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

const https = require('https');
const parseXml = require('xml-js');
// const util = require('util');

const defaultHost = 'web-api.tp.entsoe.eu'; // 'transparency.entsoe.eu';
const defaultPort = 443;
const defaultTimeout = 30000;

const regexReasonCode = /<code>(.*)<\/code>/;
const regexText = /<text>(.*)<\/text>/;

const biddingZones = {
  AL_Albania: '10YAL-KESH-----5',
  AT_Austria: '10YAT-APG------L',
  // AT_Austria_DE_AT_LU: '10Y1001A1001A63L',
  BE_Belgium: '10YBE----------2',
  // BA_Bosnia_Herzegovina: '10YBA-JPCC-----D',
  BG_Bulgaria: '10YCA-BULGARIA-R',
  // BY_Belarus: 'BY',
  // BY_Belarus_2: '10Y1001A1001A51S',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CR_Croatia: '10YHR-HEP------M',
  // CY_Cyprus: '10YCY-1001A0003J',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  // CZ_Czech_Republic_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  // CZ_Czech_Republic_PL_CZ: '10YDOM-1001A082L',
  DE_Germany: '10Y1001A1001A83F',
  // DE_Germany_50HzT: '10YDE-VE-------2',
  // DE_Germany_Amprion: '10YDE-RWENET---I',
  // DE_Germany_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  // DE_Germany_DE_AT_LU: '10Y1001A1001A63L',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  // DE_Germany_Tennet: '10YDE-EON------1',
  // DE_Germany_TransnetBW: '10YDE-ENBW-----N',
  DK_Denmark: '10Y1001A1001A65H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  DK_Denmark_Energinet: '10Y1001A1001A796',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  GB_United_Kingdom: '10Y1001A1001A92E',
  // GB_United_Kingdom_ElecLink: '11Y0-0000-0265-K',
  // GB_United_Kingdom_IE_SEM: '10Y1001A1001A59C',
  // GB_United_Kingdom_IFA: '10Y1001C--00098F',
  // GB_United_Kingdom_IFA2: '17Y0000009369493',
  GB_United_Kingdom_National_Grid: '10YGB----------A',
  GB_United_Kingdom_NIE_SONI: '10Y1001A1001A016',
  GR_Greece: '10YGR-HTSO-----Y',
  HU_Hungary: '10YHU-MAVIR----U',
  IE_Ireland_EirGrid: '10YIE-1001A00010',
  // IE_Ireland_SEM: '10Y1001A1001A59C',
  IS_Iceland: 'IS',
  IT_Italy: '10YIT-GRTN-----B',
  // IT_Italy_Brindisi: '10Y1001A1001A699',
  IT_Italy_Calabria: '10Y1001C--00096J',
  IT_Italy_Center_South: '10Y1001A1001A71M',
  IT_Italy_Centre_North: '10Y1001A1001A70O',
  // IT_Italy_Foggia: '10Y1001A1001A72K',
  // IT_Italy_GR: '10Y1001A1001A66F',
  IT_Italy_Macrozone_North: '10Y1001A1001A84D',
  IT_Italy_Macrozone_South: '10Y1001A1001A85B',
  // IT_Italy_Malta: '10Y1001A1001A877',
  IT_Italy_North: '10Y1001A1001A73I',
  // IT_Italy_North_AT: '10Y1001A1001A80L',
  // IT_Italy_North_CH: '10Y1001A1001A68B',
  // IT_Italy_North_FR: '10Y1001A1001A81J',
  // IT_Italy_North_SI: '10Y1001A1001A67D',
  // IT_Italy_Priolo: '10Y1001A1001A76C',
  // IT_Italy_Rossano: '10Y1001A1001A77A',
  IT_Italy_Saco_AC: '10Y1001A1001A885',
  IT_Italy_Saco_DC: '10Y1001A1001A893',
  IT_Italy_Sardinia: '10Y1001A1001A74G',
  IT_Italy_Sicily: '10Y1001A1001A75E',
  IT_Italy_South: '10Y1001A1001A788',
  LT_Lithuania: '10YLT-1001A0008Q',
  LU_Luxemburg_CREOS: '10YLU-CEGEDEL-NQ',
  // LU_Luxemburg_DE_AT_LU: '10Y1001A1001A63L',
  LU_Luxemburg_DE_LU: '10Y1001A1001A82H',
  LV_Latvia: '10YLV-1001A00074',
  // MD_Moldova: '10Y1001A1001A990',
  // ME_Montenegro: '10YCS-CG-TSO---S',
  MK_North_Macedonia: '10YMK-MEPSO----8',
  // MT_Malta: '10Y1001A1001A93C',
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
  // SE_Sweden_SvK: '10YSE-1--------K',
  SI_Slovenia: '10YSI-ELES-----O',
  // SK_Slovakia_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  SK_Slovakia_SEPS: '10YSK-SEPS-----K',
  // TR_Turkey: 'TR',
  TR_Turkey_TEIAS: '10YTR-TEIAS----W',
  UA_Ukaine_BEI: '10YUA-WEPS-----0',
  UA_Ukaine_DobTPP: '10Y1001A1001A869',
  UA_Ukaine_IPS: '10Y1001C--000182',
  UA_Ukraine: '10Y1001C--00003F',
  // XK_Kosovo: '10Y1001C--00100H',
  ZZ_CWE_Region: '10YDOM-REGION-1V',
};

const flatten = async (json, level) => {
  try {
    const lvl = level ? level + 1 : 1;
    if (lvl > 10) return json;
    const flat = {};
    Object.keys(json).forEach((key) => {
      if (key === '_attributes') {
        Object.keys(json[key]).forEach((attr) => {
          flat[attr] = json[key][attr];
        });
        return;
      }
      flat[key] = json[key];
      if (Object.keys(json[key]).length === 0) {
        flat[key] = undefined;
        if (key === '_text') {
          delete flat[key];
          flat.value = json[key];
        }
        return;
      }
      if (Object.keys(json[key]).length === 1) {
        if (Object.prototype.hasOwnProperty.call(json[key], '_text')) {
          flat[key] = json[key]._text;
        } else {
          flat[key] = flatten(json[key], lvl);
        }
        return;
      }
      flat[key] = flatten(json[key], lvl);
    });
    return Promise.resolve(flat);
  } catch (error) {
    return Promise.reject(error);
  }
};

// Represents a session to the ENTSOE API.
class ENTSOE {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.port = options.port || defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.apiKey = options.apiKey;
    this.biddingZone = options.biddingZone;
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
  */
  async getPrices(options) {
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      const opts = options || {};
      const zone = opts.biddingZone || this.biddingZone;
      const start = opts.dateStart ? new Date(opts.dateStart) : today;
      const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
      // start.setHours(0); // doesnt work with Homey time
      start.setMinutes(0);
      start.setSeconds(0);
      start.setMilliseconds(0);
      end.setMinutes(0);
      const interval = `${start.toISOString().replace(/.\d+Z$/g, 'Z').replace(':', '%3A')}`
        + '%2F'
        + `${end.toISOString().replace(/.\d+Z$/g, 'Z').replace(':', '%3A')}`;
      const path = `/api?securityToken=${this.apiKey}&documentType=A44&in_Domain=${zone}&out_Domain=${zone}&TimeInterval=${interval}`;
      const res = await this._makeRequest(path);

      // make array with concise info
      let info = [];
      if (res.Publication_MarketDocument && res.Publication_MarketDocument.TimeSeries) {
        // check multiple days
        let infoAllDays = {};
        if (res.Publication_MarketDocument.TimeSeries['1']) {
          infoAllDays = res.Publication_MarketDocument.TimeSeries;
        } else infoAllDays['0'] = res.Publication_MarketDocument.TimeSeries;
        // make array from object and filter only 'PT60M'
        let infoAllDaysArray = [];
        Object.values(infoAllDays).forEach((day) => infoAllDaysArray.push(day));
        infoAllDaysArray = infoAllDaysArray.filter((day) => day.Period.resolution === 'PT60M');
        // refactor to single array
        const allPrices = [];
        infoAllDaysArray.forEach((day) => {
          const startDate = new Date(day.Period.timeInterval.start);
          const pricesDay = Object.values(day.Period.Point).map((value, index) => {
            const sd = new Date(startDate);
            const hour = index;
            sd.setHours(sd.getHours() + hour);
            return { time: sd, price: value['price.amount'] };
          });
          allPrices.push(...pricesDay);
        });
        // remove out of bounds data
        info = allPrices
          .filter((price) => price.time >= start)
          .filter((price) => price.time <= end);
      } else throw Error('no timeseries data found in response');
      // console.dir(info, { depth: null, colors: true });
      return Promise.resolve(info);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(actionPath, timeout) {
    try {
      const postMessage = '';
      const headers = {};
      const options = {
        hostname: this.host,
        port: this.port,
        path: actionPath,
        headers,
        method: 'GET',
      };
      const result = await this._makeHttpsRequest(options, postMessage, timeout);
      this.lastResponse = result.body || result.statusCode;
      const contentType = result.headers['content-type'];
      if (!/\/xml/.test(contentType)) {
        throw Error(`Expected xml but received ${contentType}: ${result.body}`);
      }
      // find errors
      if (result.body && result.body.includes('<Reason>')) {
        const code = regexReasonCode.exec(result.body); // 999 = error?
        const text = regexText.exec(result.body); // error tekst
        if (code && code[1]) throw Error(`${code[1]} ${text[1]}`);
      }
      if (result.statusCode !== 200) {
        this.lastResponse = result.statusCode;
        throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
      }
      // parse xml to json object
      const parseOptions = {
        compact: true, nativeType: true, ignoreDeclaration: true, ignoreAttributes: true, // spaces: 2,
      };
      const json = parseXml.xml2js(result.body, parseOptions);
      const flatJson = await flatten(json);
      // console.dir(flatJson, { depth: null });
      return Promise.resolve(flatJson);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _makeHttpsRequest(options, postData, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.httpsAgent) {
        const agentOptions = {
          rejectUnauthorized: false,
        };
        this.httpsAgent = new https.Agent(agentOptions);
      }
      const opts = options;
      opts.timeout = timeout || this.timeout;
      const req = https.request(opts, (res) => {
        let resBody = '';
        res.on('data', (chunk) => {
          resBody += chunk;
        });
        res.once('end', () => {
          this.lastResponse = resBody;
          if (!res.complete) {
            return reject(Error('The connection was terminated while the message was still being sent'));
          }
          res.body = resBody;
          return resolve(res);
        });
      });
      req.on('error', (e) => {
        req.destroy();
        this.lastResponse = e;
        return reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.end(postData);
    });
  }

}

module.exports = ENTSOE;

// // START TEST HERE
// const Entsoe = new ENTSOE({ biddingZone: '10YCZ-CEPS-----N', apiKey: '' }); // '10Y1001A1001A82H'
// console.log('REMOVE APIKEY!!!!!');

// // const today = new Date();
// // today.setHours(0);
// // const tomorrow = new Date(today);
// // tomorrow.setDate(tomorrow.getDate() + 1);

// const dateStart = new Date('2022-12-11T23:00:00.000Z'); // today;
// const dateEnd = new Date('2022-12-13T23:00:00.000Z'); // tomorrow;

// Entsoe.getPrices({ dateStart, dateEnd })
//  .then((result) => console.dir(result, { depth: null }))
//  .catch((error) => console.log(error));

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

/**
* @class ENTSOE
* @classdesc Class representing a session with the ENTSOE service
* @param {sessionOptions} [options] - configurable session options
* @example // create a session, fetch prices for today
  const Entsoe = require('ENTSOE');

  const Entsoe = new ENTSOE({sessionOptions});
  const today = new Date();

  Entsoe.getPrices('10YNL----------L', today, today)
    .then((result) => console.dir(result, { depth: null }))
    .catch((error) => console.log(error));
*/

/**
* @typedef sessionOptions
* @description Set of configurable options to set on the class
* @property {string} apiKey - the API key
* @property {string} [host = 'transparency.entsoe.eu'] - The url or ip address of the ENTSOE API.
* @property {number} [port = 443] - The port of the service
* @property {number} [timeout = 30000] - https timeout in milliseconds. Defaults to 30000ms.
* @example // session options
{
  apiKey: '1234-your-api-key-5678',
  timeout: 15000,
}
*/
