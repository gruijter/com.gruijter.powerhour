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

const defaultHost = 'stekker.app';
const defaultTimeout = 30000;

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  BG_Bulgaria: '10YCA-BULGARIA-R',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CR_Croatia: '10YHR-HEP------M',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  HU_Hungary: '10YHU-MAVIR----U',
  IT_Italy_Calabria: '10Y1001C--00096J',
  IT_Italy_Center_South: '10Y1001A1001A71M',
  IT_Italy_Centre_North: '10Y1001A1001A70O',
  IT_Italy_North: '10Y1001A1001A73I',
  IT_Italy_Saco_AC: '10Y1001A1001A885',
  IT_Italy_Saco_DC: '10Y1001A1001A893',
  IT_Italy_Sardinia: '10Y1001A1001A74G',
  IT_Italy_Sicily: '10Y1001A1001A75E',
  IT_Italy_South: '10Y1001A1001A788',
  LT_Lithuania: '10YLT-1001A0008Q',
  LV_Latvia: '10YLV-1001A00074',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_1: '10YNO-1--------2',
  NO_Norway_2: '10YNO-2--------T',
  NO_Norway_3: '10YNO-3--------J',
  NO_Norway_4: '10YNO-4--------9',
  NO_Norway_5: '10Y1001A1001A48H',
  PL_Poland_PSE: '10YPL-AREA-----S',
  PT_Portugal: '10YPT-REN------W',
  RS_Serbia: '10YCS-SERBIATSOV',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
  SI_Slovenia: '10YSI-ELES-----O',
  SK_Slovakia_SEPS: '10YSK-SEPS-----K',
};

// mapping for stekker page, region name
const biddingZonesMap = {
  '10YAT-APG------L': ['AT-3600'], // AT_Austria
  '10YBE----------2': ['BE-3600', 'BE-900'], // BE_Belgium
  '10YCA-BULGARIA-R': ['BG-3600'], // BG_Bulgaria
  '10YCH-SWISSGRIDZ': ['CH-3600'], // CH_Switzerland
  '10YHR-HEP------M': ['HR-3600'], // CR_Croatia
  '10YCZ-CEPS-----N': ['CZ-3600'], // CZ_Czech_Republic_CEPS
  '10Y1001A1001A82H': ['DE-LU-3600', 'DE-LU-900'], // DE_Germany_DE_LU
  '10YDK-1--------W': ['DK1-3600'], // DK_Denmark_1
  '10YDK-2--------M': ['DK2-3600'], // DK_Denmark_2
  '10Y1001A1001A39I': ['EE-3600'], // EE_Estonia
  '10YES-REE------0': ['ES-3600'], // ES_Spain
  '10YFI-1--------U': ['FI-3600'], // FI_Finland
  '10YFR-RTE------C': ['FR-3600'], // FR_France
  '10YHU-MAVIR----U': ['HU-3600'], // HU_Hungary
  '10Y1001C--00096J': ['IT-CALABRIA-3600'], // IT_Italy_Calabria
  '10Y1001A1001A71M': ['IT-CENTRE_SOUTH-3600'], // IT_Italy_Center_South
  '10Y1001A1001A70O': ['IT-CENTRE_NORTH-3600'], // IT_Italy_Centre_North
  '10Y1001A1001A73I': ['IT-NORTH-3600'], // IT_Italy_North
  '10Y1001A1001A885': ['IT-SACO_AC-3600'], // IT_Italy_Saco_AC
  '10Y1001A1001A893': ['IT-SACODC-3600'], // IT_Italy_Saco_DC
  '10Y1001A1001A74G': ['IT-SARDINIA-3600'], // IT_Italy_Sardinia
  '10Y1001A1001A75E': ['IT-SICILY-3600'], // IT_Italy_Sicily
  '10Y1001A1001A788': ['IT-SOUTH-3600'], // IT_Italy_South
  '10YLT-1001A0008Q': ['LT-3600'], // LT_Lithuania
  '10YLV-1001A00074': ['LV-3600'], // LV_Latvia
  '10YNL----------L': ['NL-3600', 'NL-900'], // NL_Netherlands
  '10YNO-1--------2': ['NO1-3600'], // NO_Norway_1
  '10YNO-2--------T': ['NO2-3600'], // NO_Norway_2
  '10YNO-3--------J': ['NO3-3600'], // NO_Norway_3
  '10YNO-4--------9': ['NO4-3600'], // NO_Norway_4
  '10Y1001A1001A48H': ['NO5-3600'], // NO_Norway_5
  '10YPL-AREA-----S': ['PL-3600'], // PL_Poland_PSE
  '10YPT-REN------W': ['PT-3600'], // PT_Portugal
  '10YCS-SERBIATSOV': ['RS-3600'], // RS_Serbia
  '10Y1001A1001A44P': ['SE1-3600'], // SE_Sweden_1 Lulea
  '10Y1001A1001A45N': ['SE2-3600'], // SE_Sweden_2 Sundsvall
  '10Y1001A1001A46L': ['SE3-3600'], // SE_Sweden_3 Stockholm
  '10Y1001A1001A47J': ['SE4-3600'], // SE_Sweden_4 Malmo
  '10YSI-ELES-----O': ['SI-3600'], // SI_Slovenia
  '10YSK-SEPS-----K': ['SK-3600'], // SK_Slovakia_SEPS
};

class Stekker extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.biddingZone = options.biddingZone;
    this.resolution = options.resolution || 'PT15M';
    this.lastResponse = undefined;
  }

  getBiddingZones() {
    return biddingZones;
  }

  /**
   * Stekker App API.
   * Uses a 5-minute spread to distribute load.
   */
  getRateLimit() {
    return { minDelay: 30000, maxRandomDelay: 300000 };
  }

  async getPrices(options) {
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      const opts = options || {};
      const zone = opts.biddingZone || this.biddingZone;
      const start = opts.dateStart ? new Date(opts.dateStart) : today;
      const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
      const { forecast, regionOverride } = opts;
      const resolution = opts.resolution || this.resolution;

      if (!zone || !biddingZonesMap[zone]) throw Error('biddingZone not supported by Stekker');
      // Format dates as YYYY-MM-DD.
      // Subtract 12 hours from start to ensure we cover the full local day (UTC-1 to UTC+3)
      // Add 24 hours to end because filter_to is exclusive and we need to cover the full end day
      const startDate = new Date(start.getTime() - 43200000).toISOString().split('T')[0];
      const endDate = new Date(end.getTime() + 86400000).toISOString().split('T')[0];

      const zoneCodes = biddingZonesMap[zone];
      let region = zoneCodes[0];
      if (resolution === 'PT15M' || resolution === 'PT30M') {
        const subHourly = zoneCodes.find((c) => c.includes('-900') || c.includes('-1800'));
        if (subHourly) region = subHourly;
      }
      if (regionOverride) region = regionOverride;

      const unit = 'MWh';

      let path = `/epex-forecast?advanced_view=&region=${region}&unit=${unit}`;
      if (!forecast) path += `&filter_from=${startDate}&filter_to=${endDate}`; // forecast data is always latest

      const res = await this._makeRequest(path);

      if (!res.includes('price')) throw Error('no price data found');
      // Extract the full graph data JSON from the HTML attribute
      const regex = /data-epex-forecast-graph-data-value="(.*?)"/;
      const match = regex.exec(res);
      if (!match) throw Error('no price data found in response');

      const jsonStr = match[1].replace(/&quot;/gm, '"');
      const datasets = JSON.parse(jsonStr);

      // Find the correct dataset
      const targetName = forecast ? 'Forecast price' : 'Market price';
      const data = datasets.find((d) => d.name && d.name.includes(targetName));

      if (!data) throw Error(`Dataset '${targetName}' not found`);

      const times = data.x;
      const prices = data.y;

      if (times.length !== prices.length) throw Error('Market times and prices length do not match');

      let info = times
        .map((time, idx) => ({ time: new Date(time), price: prices[idx] }))
        .filter((hour) => hour.price !== null)
        .sort((a, b) => a.time - b.time)
        .filter((item, pos, ary) => !pos || item.time.getTime() !== ary[pos - 1].time.getTime()); // remove duplicates

      // FIX: Stekker returns hourly average at xx:00 for 15m data in non-900 regions (e.g. SE4-3600)
      // We reconstruct the correct xx:00 price: Q1 = 4*Avg - Q2 - Q3 - Q4
      if (!region.includes('-900')) {
        const timeMap = new Map(info.map((i) => [i.time.getTime(), i]));
        for (const item of info) {
          if (item.time.getUTCMinutes() === 0) {
            const t = item.time.getTime();
            const p15 = timeMap.get(t + 15 * 60000);
            const p30 = timeMap.get(t + 30 * 60000);
            const p45 = timeMap.get(t + 45 * 60000);

            if (p15 && p30 && p45) {
              const q1 = 4 * item.price - p15.price - p30.price - p45.price;
              item.price = Number(q1.toFixed(3));
            }
          }
        }
      }

      // Convert to 15 minute intervals if requested
      if (resolution === 'PT15M' && info.length > 0) {
        // Check if we have sub-30m intervals (15m).
        const hasSub30m = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 1800000);
        if (!hasSub30m) {
          if (forecast) {
            // Check if we have sub-hourly intervals (30m).
            const hasSubHourly = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 3600000);
            const steps = hasSubHourly ? 2 : 4;

            const newInfo = [];
            info.forEach((i) => {
              for (let j = 0; j < steps; j += 1) {
                newInfo.push({
                  time: new Date(i.time.getTime() + (j * 15 * 60 * 1000)),
                  price: i.price,
                });
              }
            });
            info = newInfo;
          } else {
            throw new Error('No 15m resolution available');
          }
        }
      }

      // Convert to 30 minute intervals if requested
      if (resolution === 'PT30M' && info.length > 0) {
        // Check if we have sub-hourly intervals. Assume hourly if no interval < 60 mins
        const hasSubHourly = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 3600000);
        if (!hasSubHourly) {
          throw new Error('No 30m resolution available');
        }

        // Average to 30 minute intervals if we have higher resolution
        const hasSub30m = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 1800000);
        if (hasSub30m) {
          const halfHourlyMap = new Map();
          for (const entry of info) {
            const hour = new Date(entry.time);
            const mins = hour.getUTCMinutes();
            hour.setUTCMinutes(mins < 30 ? 0 : 30, 0, 0);
            const key = hour.getTime();
            if (!halfHourlyMap.has(key)) halfHourlyMap.set(key, []);
            halfHourlyMap.get(key).push(entry.price);
          }
          info = Array.from(halfHourlyMap.entries()).map(([time, priceArr]) => ({
            time: new Date(Number(time)),
            price: priceArr.reduce((a, b) => a + b, 0) / priceArr.length,
          }));
          info.sort((a, b) => a.time - b.time);
        }
      }

      // Average to 60 minute intervals if requested
      if (resolution === 'PT60M' && info.length > 0) {
        const hasSubHourly = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 3600000);
        if (hasSubHourly) {
          const hourlyMap = new Map();
          for (const entry of info) {
            const hour = new Date(entry.time);
            hour.setUTCMinutes(0, 0, 0);
            const key = hour.getTime();
            if (!hourlyMap.has(key)) hourlyMap.set(key, []);
            hourlyMap.get(key).push(entry.price);
          }
          info = Array.from(hourlyMap.entries()).map(([time, priceArr]) => ({
            time: new Date(Number(time)),
            price: priceArr.reduce((a, b) => a + b, 0) / priceArr.length,
          }));
          info.sort((a, b) => a.time - b.time);
        }
      }

      if (forecast) {
        info = info.map((hour) => ({ time: hour.time, price: Math.round(hour.price * 100) / 100 }));
      } else {
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
      const url = `https://${this.host}${actionPath}`;
      const options = {
        method: 'GET',
        timeout: timeout || this.timeout,
      };

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      if (!result.ok) {
        if (result.status === 422) throw new Error('Region not supported (422)');

        const text = await result.text();
        let errorMsg = text.slice(0, 100);
        if (text.includes('<!DOCTYPE html>')) {
          const title = text.match(/<title>(.*?)<\/title>/);
          if (title) errorMsg = title[1].replace(' - Stekker.com price forecast', '');
          else errorMsg = 'HTML Error';
        }
        throw new Error(`HTTP request Failed. Status Code: ${result.status} ${errorMsg}`);
      }

      const contentType = result.headers.get('content-type');
      if (!/text\/html/.test(contentType)) {
        const text = await result.text();
        throw new Error(`Expected HTML but received ${contentType}: ${text.slice(0, 100)}`);
      }
      return result.text();
    } catch (error) {
      this.lastResponse = error;
      return Promise.reject(error);
    }
  }
}

module.exports = Stekker;
