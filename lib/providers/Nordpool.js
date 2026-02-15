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

const defaultHost = 'dataportal-api.nordpoolgroup.com';
const defaultTimeout = 30000;

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  EE_Estonia: '10Y1001A1001A39I',
  FI_Finland: '10YFI-1--------U',
  FR_France: '10YFR-RTE------C',
  LT_Lithuania: '10YLT-1001A0008Q',
  LV_Latvia: '10YLV-1001A00074',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_1: '10YNO-1--------2',
  NO_Norway_2: '10YNO-2--------T',
  NO_Norway_3: '10YNO-3--------J',
  NO_Norway_4: '10YNO-4--------9',
  NO_Norway_5: '10Y1001A1001A48H',
  PL_Poland_PSE: '10YPL-AREA-----S',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
};

const zoneMap = {
  '10YAT-APG------L': 'AT',
  '10YBE----------2': 'BE',
  '10Y1001A1001A82H': 'DE-LU',
  '10YDK-1--------W': 'DK1',
  '10YDK-2--------M': 'DK2',
  '10Y1001A1001A39I': 'EE',
  '10YFI-1--------U': 'FI',
  '10YFR-RTE------C': 'FR',
  '10YLT-1001A0008Q': 'LT',
  '10YLV-1001A00074': 'LV',
  '10YNL----------L': 'NL',
  '10YNO-1--------2': 'NO1',
  '10YNO-2--------T': 'NO2',
  '10YNO-3--------J': 'NO3',
  '10YNO-4--------9': 'NO4',
  '10Y1001A1001A48H': 'NO5',
  '10YPL-AREA-----S': 'PL',
  '10Y1001A1001A44P': 'SE1',
  '10Y1001A1001A45N': 'SE2',
  '10Y1001A1001A46L': 'SE3',
  '10Y1001A1001A47J': 'SE4',
};

class Nordpool extends PriceProvider {

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

  /**
   * Nordpool Unofficial API.
   * Uses a 5-minute spread to be polite and avoid potential blocking.
   */
  getRateLimit() {
    return { minDelay: 30000, maxRandomDelay: 300000 };
  }

  async getPrices(options) {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const opts = options || {};
    const zone = opts.biddingZone || this.biddingZone;
    const start = opts.dateStart ? new Date(opts.dateStart) : today;
    const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;

    if (!zone || !zoneMap[zone]) throw Error(`Zone ${zone} not supported by Nordpool`);
    const npZone = zoneMap[zone];

    const resolution = opts.resolution || 'PT60M';
    let interval = 60;
    if (resolution === 'PT15M') interval = 15;
    if (resolution === 'PT30M') interval = 30;

    let prices = [];
    let fetchError;
    const loopDate = new Date(start);
    loopDate.setHours(0, 0, 0, 0);
    const endDate = new Date(end);
    endDate.setHours(0, 0, 0, 0);

    while (loopDate <= endDate) {
      const day = String(loopDate.getDate()).padStart(2, '0');
      const month = String(loopDate.getMonth() + 1).padStart(2, '0');
      const year = loopDate.getFullYear();
      const dateStr = `${year}-${month}-${day}`;
      const url = `https://${this.host}/api/DayAheadPrices?date=${dateStr}&market=DayAhead&deliveryArea=${npZone}&currency=EUR`;

      try {
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: this.timeout,
        };
        const res = await fetch(url, options);
        if (!res.ok) throw Error(`Nordpool API error ${res.status} ${res.statusText}`);
        const json = await res.json();
        if (json && json.currency && json.currency !== 'EUR') throw Error(`Nordpool returned ${json.currency} instead of EUR`);

        if (json && json.multiAreaEntries) {
          for (const entry of json.multiAreaEntries) {
            const startTime = new Date(entry.deliveryStart);
            const price = entry.entryPerArea[npZone];
            if (price !== undefined && price !== null) {
              prices.push({ time: startTime, price: Number(price) });
            }
          }
        }
      } catch (err) {
        fetchError = err;
        // ignore errors for individual days, might be future date not yet available
      }
      loopDate.setDate(loopDate.getDate() + 1);
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
    if (resolution === 'PT60M') {
      const hourlyMap = new Map();
      for (const entry of prices) {
        const hour = new Date(entry.time);
        if (Number.isNaN(hour.getTime())) continue;
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

    if (prices.length === 0) {
      if (fetchError) throw fetchError;
      throw Error('No prices found');
    }
    return prices;
  }
}

module.exports = Nordpool;
