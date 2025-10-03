/*
Copyright 2019 - 2025, Robin de Gruijter (gruijter@hotmail.com)

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
// const util = require('util');

const defaultHost = 'stekker.app';
const defaultPort = 443;
const defaultTimeout = 30000;

const regExForecast = /{&quot;x&quot;:(.*?)&quot;Forecast price&quot;/;
const regExPrices = /{&quot;x&quot;:(.*?)&quot;Market price&quot;/;

const biddingZones = {
  // AL_Albania: '10YAL-KESH-----5',
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
  // CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  // CZ_Czech_Republic_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  CZ_Czech_Republic_PL_CZ: '10YDOM-1001A082L',
  // DE_Germany: '10Y1001A1001A83F',
  // DE_Germany_50HzT: '10YDE-VE-------2',
  // DE_Germany_Amprion: '10YDE-RWENET---I',
  // DE_Germany_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  // DE_Germany_DE_AT_LU: '10Y1001A1001A63L',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  // DE_Germany_Tennet: '10YDE-EON------1',
  // DE_Germany_TransnetBW: '10YDE-ENBW-----N',
  // DK_Denmark: '10Y1001A1001A65H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  // DK_Denmark_Energinet: '10Y1001A1001A796',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  // GB_United_Kingdom: '10Y1001A1001A92E',
  // GB_United_Kingdom_ElecLink: '11Y0-0000-0265-K',
  // GB_United_Kingdom_IE_SEM: '10Y1001A1001A59C',
  // GB_United_Kingdom_IFA: '10Y1001C--00098F',
  // GB_United_Kingdom_IFA2: '17Y0000009369493',
  // GB_United_Kingdom_National_Grid: '10YGB----------A',
  // GB_United_Kingdom_NIE_SONI: '10Y1001A1001A016',
  GR_Greece: '10YGR-HTSO-----Y',
  HU_Hungary: '10YHU-MAVIR----U',
  // IE_Ireland_EirGrid: '10YIE-1001A00010',
  // IE_Ireland_SEM: '10Y1001A1001A59C',
  // IS_Iceland: 'IS',
  // IT_Italy: '10YIT-GRTN-----B',
  // IT_Italy_Brindisi: '10Y1001A1001A699',
  IT_Italy_Calabria: '10Y1001C--00096J',
  IT_Italy_Center_South: '10Y1001A1001A71M',
  IT_Italy_Centre_North: '10Y1001A1001A70O',
  // IT_Italy_Foggia: '10Y1001A1001A72K',
  // IT_Italy_GR: '10Y1001A1001A66F',
  // IT_Italy_Macrozone_North: '10Y1001A1001A84D',
  // IT_Italy_Macrozone_South: '10Y1001A1001A85B',
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
  // LU_Luxemburg_CREOS: '10YLU-CEGEDEL-NQ',
  // LU_Luxemburg_DE_AT_LU: '10Y1001A1001A63L',
  // LU_Luxemburg_DE_LU: '10Y1001A1001A82H',
  LV_Latvia: '10YLV-1001A00074',
  // MD_Moldova: '10Y1001A1001A990',
  // ME_Montenegro: '10YCS-CG-TSO---S',
  // MK_North_Macedonia: '10YMK-MEPSO----8',
  // MT_Malta: '10Y1001A1001A93C',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_1: '10YNO-1--------2',
  NO_Norway_2: '10YNO-2--------T',
  // NO_Norway_2NSL: '50Y0JVU59B4JWQCU',
  NO_Norway_3: '10YNO-3--------J',
  NO_Norway_4: '10YNO-4--------9',
  NO_Norway_5: '10Y1001A1001A48H',
  // NO_Norway_Stattnet: '10YNO-0--------C',
  // PL_Poland_PL_CZ: '10YDOM-1001A082L',
  PL_Poland_PSE: '10YPL-AREA-----S',
  PT_Portugal: '10YPT-REN------W',
  RO_Romania: '10YRO-TEL------P',
  RS_Serbia: '10YCS-SERBIATSOV',
  // RU_Russia: 'RU',
  // RU_Russia_EMS: '10Y1001A1001A49F',
  // RU_Russia_Kaliningrad: '10Y1001A1001A50U',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
  // SE_Sweden_SvK: '10YSE-1--------K',
  SI_Slovenia: '10YSI-ELES-----O',
  // SK_Slovakia_CZ_DE_SK: '10YDOM-CZ-DE-SKK',
  SK_Slovakia_SEPS: '10YSK-SEPS-----K',
  // TR_Turkey: 'TR',
  // TR_Turkey_TEIAS: '10YTR-TEIAS----W',
  // UA_Ukaine_BEI: '10YUA-WEPS-----0',
  // UA_Ukaine_DobTPP: '10Y1001A1001A869',
  // UA_Ukaine_IPS: '10Y1001C--000182',
  // UA_Ukraine: '10Y1001C--00003F',
  // XK_Kosovo: '10Y1001C--00100H',
  // ZZ_CWE_Region: '10YDOM-REGION-1V',
};

// mapping for stekker page, region name
const biddingZonesMap = {
  // AL_Albania: '10YAL-KESH-----5',
  '10YAT-APG------L': ['AT'], // AT_Austria
  '10YBE----------2': ['BE'], // BE_Belgium
  '10YCA-BULGARIA-R': ['BG'], // BG_Bulgaria
  '10YCH-SWISSGRIDZ': ['CH'], // CH_Switzerland
  '10YHR-HEP------M': ['HR'], // CR_Croatia
  '10YDOM-1001A082L': ['CZ'], // CZ_Czech_Republic_PL_CZ
  // DE_Germany: '10Y1001A1001A83F',
  '10Y1001A1001A82H': ['DE-LU'], // DE_Germany_DE_LU
  // DK_Denmark: '10Y1001A1001A65H',
  '10YDK-1--------W': ['DK1'], // DK_Denmark_1
  '10YDK-2--------M': ['DK2'], // DK_Denmark_2
  // DK_Denmark_Energinet: '10Y1001A1001A796',
  '10Y1001A1001A39I': ['EE'], // EE_Estonia
  '10YES-REE------0': ['ES'], // ES_Spain
  '10YFI-1--------U': ['FI'], // FI_Finland
  '10YFR-RTE------C': ['FR'], // FR_France
  // '10Y1001A1001A92E': [325, 'GB', 'BST'], // GB_United_Kingdom:
  // GB_United_Kingdom_National_Grid: '10YGB----------A',
  // GB_United_Kingdom_NIE_SONI: '10Y1001A1001A016',
  '10YGR-HTSO-----Y': ['GR'], // GR_Greece
  '10YHU-MAVIR----U': ['HU'], // HU_Hungary
  // IE_Ireland_EirGrid: '10YIE-1001A00010',
  // IS_Iceland: 'IS',
  // IT_Italy: '10YIT-GRTN-----B',
  '10Y1001C--00096J': ['IT-CALABRIA'], // IT_Italy_Calabria
  '10Y1001A1001A71M': ['IT-CENTRE_SOUTH'], // IT_Italy_Center_South
  '10Y1001A1001A70O': ['IT-CENTRE_NORTH'], // IT_Italy_Centre_North
  // IT_Italy_Macrozone_North: '10Y1001A1001A84D',
  // IT_Italy_Macrozone_South: '10Y1001A1001A85B',
  '10Y1001A1001A73I': ['IT-NORTH'], // IT_Italy_North
  '10Y1001A1001A885': ['IT-SACO_AC'], // IT_Italy_Saco_AC
  '10Y1001A1001A893': ['IT-SACODC'], // IT_Italy_Saco_DC
  '10Y1001A1001A74G': ['IT-SARDINIA'], // IT_Italy_Sardinia
  '10Y1001A1001A75E': ['IT-SICILY'], // IT_Italy_Sicily
  '10Y1001A1001A788': ['IT-SOUTH'], // IT_Italy_South
  '10YLT-1001A0008Q': ['LT'], // LT_Lithuania
  // LU_Luxemburg_CREOS: '10YLU-CEGEDEL-NQ',
  // LU_Luxemburg_DE_LU: '10Y1001A1001A82H',
  '10YLV-1001A00074': ['LV'], // LV_Latvia
  // MK_North_Macedonia: '10YMK-MEPSO----8',
  '10YNL----------L': ['NL'], // NL_Netherlands
  '10YNO-1--------2': ['NO1'], // NO_Norway_1
  '10YNO-2--------T': ['NO2'], // NO_Norway_2
  // '50Y0JVU59B4JWQCU': [429416, 'NO2', 'BST'], // NO_Norway_2NSL > ONLY PROVIDES SINGLE DAY DATA
  '10YNO-3--------J': ['NO3'], // NO_Norway_3
  '10YNO-4--------9': ['NO4'], // NO_Norway_4
  '10Y1001A1001A48H': ['NO5'], // NO_Norway_5
  // NO_Norway_Stattnet: '10YNO-0--------C',
  // PL_Poland_PL_CZ: '10YDOM-1001A082L',
  '10YPL-AREA-----S': ['PL'], // PL_Poland_PSE
  '10YPT-REN------W': ['PT'], // PT_Portugal
  '10YRO-TEL------P': ['RO'], // RO_Romania
  '10YCS-SERBIATSOV': ['RS'], // RS_Serbia
  // RU_Russia: 'RU',
  // RU_Russia_EMS: '10Y1001A1001A49F',
  // RU_Russia_Kaliningrad: '10Y1001A1001A50U',
  '10Y1001A1001A44P': ['SE1'], // SE_Sweden_1 Lulea
  '10Y1001A1001A45N': ['SE2'], // SE_Sweden_2 Sundsvall
  '10Y1001A1001A46L': ['SE3'], // SE_Sweden_3 Stockholm
  '10Y1001A1001A47J': ['SE4'], // SE_Sweden_4 Malmo
  // '10YSE-1--------K': [29, 'SE'], // SE_Sweden_SvK
  '10YSI-ELES-----O': ['SI'], // SI_Slovenia
  '10YSK-SEPS-----K': ['SK'], // SK_Slovakia_SEPS
  // TR_Turkey_TEIAS: '10YTR-TEIAS----W',
  // UA_Ukaine_BEI: '10YUA-WEPS-----0',
  // UA_Ukaine_DobTPP: '10Y1001A1001A869',
  // UA_Ukaine_IPS: '10Y1001C--000182',
  // UA_Ukraine: '10Y1001C--00003F',
  // ZZ_CWE_Region: '10YDOM-REGION-1V',
};

// Represents a session to the STEKKER API (EPEX MARKET and FORECAST)
class Stekker {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.port = options.port || defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    // this.apiKey = options.apiKey;
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
      const { forecast } = opts;
      // start.setHours(0);
      start.setMinutes(0); // set start of the day
      start.setSeconds(0);
      start.setMilliseconds(0);
      end.setDate(end.getDate() + 1); // set end of the day

      if (!zone || !biddingZonesMap[zone]) throw Error('biddingZone not supported by Stekker');
      // convert from UTC to CET/CEST for API request
      // const timeZone = 'Europe/Amsterdam'; // biddingZonesMap[zone][2] === 'BST' ? 'Europe/London' : 'Europe/Amsterdam';
      const startDate = start.toISOString(); //
      const endDate = end.toISOString(); // .toLocaleString().split(' ')[0];

      // construct API path
      const region = biddingZonesMap[zone][0];
      let path = `/epex-forecast?advanced_view=&region=${region}&unit=MWh`;
      if (!forecast) path += `&filter_from=${startDate}&filter_to=${endDate}}`; // forecast data is always latest
      // console.log(startDate, endDate, path);
      const res = await this._makeRequest(path);
      if (!res.includes('price')) throw Error('no price data found');
      let data;
      if (forecast) { // find forecast market prices
        // eslint-disable-next-line prefer-destructuring
        data = regExForecast
          .exec(res)[0]
          .replace(/&quot;/gm, '"') // &quot; >> "
          .split('{"x":')
          .filter((s) => s.includes('Forecast price'))[0];
      } else { // find EPEX market prices
        // eslint-disable-next-line prefer-destructuring
        data = regExPrices
          .exec(res)[0]
          .replace(/&quot;/gm, '"') // &quot; >> "
          .split('{"x":')
          .filter((s) => s.includes('Market price'))[0];
      }
      const times = JSON.parse(data.split(',"y":')[0]);
      const prices = JSON.parse(data.split(',"y":')[1].split(',"line"')[0]);
      if (times.length !== prices.length) throw Error('Market times and prices length do not match');
      let info = times
        .map((time, idx) => ({ time: new Date(time), price: prices[idx] }))
        .filter((hour) => hour.price !== null)
        .sort((a, b) => a.time - b.time);
      if (forecast) { // round prices to 2 digits
        info = info.map((hour) => ({ time: hour.time, price: Math.round(hour.price * 100) / 100 }));
      } else { // remove out of bounds data
        info = info
          .filter((hourInfo) => hourInfo.time >= start)
          .filter((hourInfo) => hourInfo.time < end);
      }
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
      if (!/text\/html/.test(contentType)) {
        throw Error(`Expected HTML but received ${contentType}: ${result.body}`);
      }
      // find errors
      if (result.statusCode !== 200) {
        this.lastResponse = result.statusCode;
        throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
      }
      return Promise.resolve(result.body);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _makeHttpsRequest(options, postData, timeout) {
    return new Promise((resolve, reject) => {
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

module.exports = Stekker;

// // START TEST HERE
// const EF = new Stekker({ biddingZone: '10YNL----------L' }); // '10YNL----------L' '10Y1001A1001A92E'

// const today = new Date();
// today.setHours(0);
// const yesterday = new Date(today);
// const tomorrow = new Date(today);
// yesterday.setDate(yesterday.getDate() - 1);
// tomorrow.setDate(tomorrow.getDate() + 1);

// EF.getPrices({ dateStart: today, dateEnd: tomorrow, forecast: true })
//   .then((result) => console.dir(result, { depth: null }))
//   .catch((error) => console.log(error));

// definitions for JSDoc

/**
* @typedef priceInfo
* @description Array of prices with UTC timestamp
* @property {array} prices - Array with object including UTC time and price
* @example
[
  { time: 2024-01-25T23:00:00.000Z, price: 52.16 },
  { time: 2024-01-26T00:00:00.000Z, price: 40.17 },
  { time: 2024-01-26T01:00:00.000Z, price: 37.47 },
  { time: 2024-01-26T02:00:00.000Z, price: 32.88 },
  { time: 2024-01-26T03:00:00.000Z, price: 34.91 },
  { time: 2024-01-26T04:00:00.000Z, price: 37.97 },
  { time: 2024-01-26T05:00:00.000Z, price: 48.36 },
  { time: 2024-01-26T06:00:00.000Z, price: 54.54 },
  { time: 2024-01-26T07:00:00.000Z, price: 61.11 },
  { time: 2024-01-26T08:00:00.000Z, price: 59.7 },
  { time: 2024-01-26T09:00:00.000Z, price: 52.87 },
  { time: 2024-01-26T10:00:00.000Z, price: 46.03 },
  { time: 2024-01-26T11:00:00.000Z, price: 40.57 },
  { time: 2024-01-26T12:00:00.000Z, price: 38.46 },
  { time: 2024-01-26T13:00:00.000Z, price: 46.65 },
  { time: 2024-01-26T14:00:00.000Z, price: 49.27 },
  { time: 2024-01-26T15:00:00.000Z, price: 59.56 },
  { time: 2024-01-26T16:00:00.000Z, price: 72.99 },
  { time: 2024-01-26T17:00:00.000Z, price: 76.17 },
  { time: 2024-01-26T18:00:00.000Z, price: 60.42 },
  { time: 2024-01-26T19:00:00.000Z, price: 53.22 },
  { time: 2024-01-26T20:00:00.000Z, price: 47.46 },
  { time: 2024-01-26T21:00:00.000Z, price: 39.24 },
  { time: 2024-01-26T22:00:00.000Z, price: 33.71 },
  { time: 2024-01-26T23:00:00.000Z, price: 34.38 },
  { time: 2024-01-27T00:00:00.000Z, price: 41.74 },
  { time: 2024-01-27T01:00:00.000Z, price: 37.11 },
  { time: 2024-01-27T02:00:00.000Z, price: 34.53 },
  { time: 2024-01-27T03:00:00.000Z, price: 33.45 },
  { time: 2024-01-27T04:00:00.000Z, price: 34.59 },
  { time: 2024-01-27T05:00:00.000Z, price: 38.57 },
  { time: 2024-01-27T06:00:00.000Z, price: 41.46 },
  { time: 2024-01-27T07:00:00.000Z, price: 53.89 },
  { time: 2024-01-27T08:00:00.000Z, price: 55.63 },
  { time: 2024-01-27T09:00:00.000Z, price: 50.08 },
  { time: 2024-01-27T10:00:00.000Z, price: 41.71 },
  { time: 2024-01-27T11:00:00.000Z, price: 37.04 },
  { time: 2024-01-27T12:00:00.000Z, price: 34.48 },
  { time: 2024-01-27T13:00:00.000Z, price: 39.8 },
  { time: 2024-01-27T14:00:00.000Z, price: 46.94 },
  { time: 2024-01-27T15:00:00.000Z, price: 51.63 },
  { time: 2024-01-27T16:00:00.000Z, price: 61.02 },
  { time: 2024-01-27T17:00:00.000Z, price: 59.83 },
  { time: 2024-01-27T18:00:00.000Z, price: 50.89 },
  { time: 2024-01-27T19:00:00.000Z, price: 44.48 },
  { time: 2024-01-27T20:00:00.000Z, price: 38.21 },
  { time: 2024-01-27T21:00:00.000Z, price: 34.83 },
  { time: 2024-01-27T22:00:00.000Z, price: 32.85 }
]
*/

/**
https://stekker.app/epex-forecast?advanced_view=&region=NL&unit=MWh
https://stekker.app/epex-forecast?advanced_view=&region=NL&filter_from=2024-01-22&filter_to=2024-01-26&show_historic_forecasts=0&show_historic_forecasts=1&unit=MWh&commit=Opslaan

  <option value="GO-5H-2330">GB: Octopus Go (5H from 23:30)</option>
  <option value="GO-5H-2130-21-12-23">Octopus Go Faster (5H from 2130) December 2021 v1</option>
  <option value="GO-21-12-23">Octopus Go (4H from 00:30 to 4:30) December 2021 v1</option>
  <option value="GO-4H-2130-21-12-23">Octopus Go Faster (4H from 2130) December 2021 v1</option>
  <option value="GO-4H-0130-21-12-23">Octopus Go Faster (4H from 0130) December 2021 v1</option>
  <option value="GO-5H-2330-21-12-23">Octopus Go Faster (5H from 2330) December 2021 v1</option>
  <option value="GO-4H-2330-21-12-23">Octopus Go Faster (4H from 2330) December 2021 v1</option>
  <option value="GO-5H-2230-21-12-23">Octopus Go Faster (5H from 2230) December 2021 v1</option>
  <option value="GO-5H-0030-21-12-23">Octopus Go Faster (5H from 0030) December 2021 v1</option>
  <option value="GO-4H-2230-21-12-23">Octopus Go Faster (4H from 2230) December 2021 v1</option>
  <option value="GO-4H-0230-21-12-23">Octopus Go Faster (4H from 0230) December 2021 v1</option>
  <option value="GO-5H-0130-21-12-23">Octopus Go Faster (5H from 0130) December 2021 v1</option>
  <option value="AGILE-18-02-21">GB: Agile Octopus</option>
  <option value="SK">Slovak Republic</option>
  <option value="SE4">Sweden: Malmo</option>
  <option value="AT">Austria</option>
  <option value="NO4">North Norway</option>
  <option value="SE1">Sweden: Lulea</option>
  <option value="SE3">Sweden: Stockholm</option>
  <option value="BE">Belgium</option>
  <option value="NO3">Middle Norway</option>
  <option value="NO5">West Norway</option>
  <option value="DE-LU">Germany-Luxemburg</option>
  <option value="GR">Greece</option>
  <option value="CH">Switzerland</option>
  <option value="LV">Latvia</option>
  <option value="NO1">South-east Norway</option>
  <option value="IT-SACODC">Italy Saco_DC</option>
  <option value="SE2">Sweden: Sundsvall</option>
  <option value="DK1">West-Denmark</option>
  <option selected="selected" value="NL">Netherlands</option>
  <option value="FR">France</option>
  <option value="DE-LU">Luxembourg</option>
  <option value="DE-LU">Germany</option>
  <option value="BG">Bulgaria</option>
  <option value="CZ">Czechia</option>
  <option value="LT">Lithuania</option>
  <option value="NO2">South-west Norway</option>
  <option value="DK2">East-Denmark</option>
  <option value="HU">Hungary</option>
  <option value="PL">Poland</option>
  <option value="IT-CENTRE_NORTH">Italy Centre North</option>
  <option value="IT-CENTRE_SOUTH">Italy Centre South</option>
  <option value="IT-SACO_AC">Italy Saco AC</option>
  <option value="IT-CALABRIA">Italy Calabria</option>
  <option value="IT-SOUTH">Italy South</option>
  <option value="HR">Croatia</option>
  <option value="RS">Serbia</option>
  <option value="FI">Finland</option>
  <option value="ES">Spain</option>
  <option value="EE">Estonia</option>
  <option value="SI">Slovenia</option>
  <option value="PT">Portugal</option>
  <option value="RO">Romania</option>
  <option value="IT-SICILY">Italy Sicily</option>
  <option value="IT-SARDINIA">Italy Sardinia</option>
  <option value="IT-NORTH">Italy North</option>
*/
