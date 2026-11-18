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
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CR_Croatia: '10YHR-HEP------M',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  EE_Estonia: '10Y1001A1001A39I',
  ES_Spain: '10YES-REE------0',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  HU_Hungary: '10YHU-MAVIR----U',
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

const biddingZonesMap = {
  '10YAT-APG------L': ['AT-3600'],
  '10YBE----------2': ['BE-3600', 'BE-900'],
  '10YCH-SWISSGRIDZ': ['CH-3600'],
  '10YHR-HEP------M': ['HR-3600'],
  '10YCZ-CEPS-----N': ['CZ-3600'],
  '10YDK-1--------W': ['DK1-3600'],
  '10YDK-2--------M': ['DK2-3600'],
  '10Y1001A1001A39I': ['EE-3600'],
  '10YES-REE------0': ['ES-3600'],
  '10YFI-1--------U': ['FI-3600'],
  '10YFR-RTE------C': ['FR-3600'],
  '10YHU-MAVIR----U': ['HU-3600'],
  '10YLT-1001A0008Q': ['LT-3600'],
  '10YLV-1001A00074': ['LV-3600'],
  '10YNL----------L': ['NL-3600', 'NL-900'],
  '10YNO-1--------2': ['NO1-3600'],
  '10YNO-2--------T': ['NO2-3600'],
  '10YNO-3--------J': ['NO3-3600'],
  '10YNO-4--------9': ['NO4-3600'],
  '10Y1001A1001A48H': ['NO5-3600'],
  '10YPL-AREA-----S': ['PL-3600'],
  '10YPT-REN------W': ['PT-3600'],
  '10YCS-SERBIATSOV': ['RS-3600'],
  '10Y1001A1001A44P': ['SE1-3600'],
  '10Y1001A1001A45N': ['SE2-3600'],
  '10Y1001A1001A46L': ['SE3-3600'],
  '10Y1001A1001A47J': ['SE4-3600'],
  '10YSI-ELES-----O': ['SI-3600'],
  '10YSK-SEPS-----K': ['SK-3600'],
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

  getRateLimit() {
    return { ...super.getRateLimit(), revalidateInterval: 0 };
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
      const startDate = new Date(start.getTime() - 43200000).toISOString().split('T')[0];
      const endDate = new Date(end.getTime() + 86400000).toISOString().split('T')[0];

      const zoneCodes = biddingZonesMap[zone];
      const subHourlyRegion = zoneCodes.find((c) => c.includes('-900') || c.includes('-1800'));
      const hourlyRegion = zoneCodes.find((c) => c.includes('-3600')) || zoneCodes[0];
      let regions = (resolution === 'PT15M' || resolution === 'PT30M')
        ? [subHourlyRegion, hourlyRegion]
        : [hourlyRegion, subHourlyRegion];
      regions = regions.filter((region, idx) => region && regions.indexOf(region) === idx);
      if (regionOverride) regions = [regionOverride];

      let info = null;
      let regionError;
      for (const region of regions) {
        try {
          const regionInfo = await this._getRegionPrices(region, { startDate, endDate, forecast });
          if (regionInfo.length > 0) {
            info = regionInfo;
            break;
          }
        } catch (error) {
          regionError = error;
        }
      }
      if (!info) throw regionError || Error('no price data found');

      if (resolution === 'PT15M' && info.length > 0) {
        const hasSub30m = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 1800000);
        if (!hasSub30m) {
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
        }
      }

      if (resolution === 'PT30M' && info.length > 0) {
        const hasSubHourly = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 3600000);
        if (!hasSubHourly) {
          throw new Error('No 30m resolution available');
        }

        const hasSub30m = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 1800000);
        if (hasSub30m) info = PriceProvider.aggregateTo(info, 30);
      }

      if (resolution === 'PT60M' && info.length > 0) {
        const hasSubHourly = info.some((p, i) => i > 0 && (p.time - info[i - 1].time) < 3600000);
        if (hasSubHourly) info = PriceProvider.aggregateTo(info, 60);
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

  async _getRegionPrices(region, opts) {
    const { startDate, endDate, forecast } = opts;
    const unit = 'MWh';

    let path = `/epex-forecast?advanced_view=&region=${region}&unit=${unit}`;
    if (!forecast) path += `&filter_from=${startDate}&filter_to=${endDate}`;

    const res = await this._makeRequest(path);

    if (!res.includes('price')) throw Error('no price data found');
    const regex = /data-epex-forecast-graph-data-value="(.*?)"/;
    const match = regex.exec(res);
    if (!match) throw Error('no price data found in response');

    let datasets;
    try {
      const jsonStr = match[1].replace(/&quot;/gm, '"');
      datasets = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Failed to parse Stekker JSON data: ${e.message}`);
    }

    const targetName = forecast ? 'Forecast price' : 'Market price';
    const data = datasets.find((d) => d.name && d.name.includes(targetName));

    if (!data) throw Error(`Dataset '${targetName}' not found`);

    const times = data.x;
    const prices = data.y;

    if (times.length !== prices.length) throw Error('Market times and prices length do not match');

    const info = times
      .map((time, idx) => ({ time: new Date(time), price: prices[idx] }))
      .filter((hour) => hour.price !== null)
      .sort((a, b) => a.time - b.time)
      .filter((item, pos, ary) => !pos || item.time.getTime() !== ary[pos - 1].time.getTime());

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

    return info;
  }

  async _makeRequest(actionPath, timeout) {
    try {
      const url = `https://${this.host}${actionPath}`;
      const reqTimeout = timeout || this.timeout;
      const options = {
        method: 'GET',
        signal: AbortSignal.timeout(reqTimeout),
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
