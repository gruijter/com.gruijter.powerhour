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

const defaultHost = 'api.eex-group.com'; // EOD and EGSI
const defaultTimeout = 30000;

const biddingZones = {
  TTF_EOD: 'TTF_EOD',
  TTF_EGSI: 'TTF_EGSI',
  CEGH_VTP_EOD: 'CEGH_VTP_EOD',
  CEGH_VTP_EGSI: 'CEGH_VTP_EGSI',
  CZ_VTP_EOD: 'CZ_VTP_EOD',
  CZ_VTP_EGSI: 'CZ_VTP_EGSI',
  ETF_EOD: 'ETF_EOD',
  ETF_EGSI: 'ETF_EGSI',
  FIN_EOD: 'FIN_EOD',
  FIN_EGSI: 'FIN_EGSI',
  LTU_EOD: 'LTU_EOD',
  LTU_EGSI: 'LTU_EGSI',
  LVA_EST_EOD: 'LVA_EST_EOD',
  LVA_EST_EGSI: 'LVA_EST_EGSI',
  THE_EOD: 'THE_EOD',
  THE_EGSI: 'THE_EGSI',
  PEG_EOD: 'PEG_EOD',
  PEG_EGSI: 'PEG_EGSI',
  ZTP_EOD: 'ZTP_EOD',
  ZTP_EGSI: 'ZTP_EGSI',
  PVB_EOD: 'PVB_EOD',
  PVB_EGSI: 'PVB_EGSI',
  NBP_EOD: 'NBP_EOD',
  NBP_EGSI: 'NBP_EGSI',
};

const padMissingHours = (data) => {
  const paddedData = [];
  data.forEach((currentEntry, idx) => {
    let hoursDiff = 1;
    if (idx > 0) {
      const previousEntry = { ...data[idx - 1] };
      const currTime = new Date(currentEntry.time);
      const prevTime = new Date(previousEntry.time);
      const prevPrice = previousEntry.price; // Set previous price for potential gaps
      hoursDiff = (currTime - prevTime) / (1000 * 60 * 60); // Calculate the difference in hours
      while (hoursDiff > 1) { // If more than 1 hour difference, fill the gap
        prevTime.setUTCHours(prevTime.getUTCHours() + 1);
        paddedData.push({
          time: new Date(prevTime), // new hour
          price: prevPrice, // use the previous price
        });
        hoursDiff--;
      }
    }
    if (hoursDiff > 0) paddedData.push(data[idx]); // Push the current entry to the result, remove double hours
  });
  return (paddedData);
};

// Represents a session to the PowerNext API.
class EEX extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.biddingZone = options.biddingZone;
    this.biddingZones = biddingZones;
    this.lastResponse = undefined;
  }

  getBiddingZones() {
    return this.biddingZones;
  }

  /**
   * EEX Website API.
   * Uses a 5-minute spread to distribute load.
   */
  getRateLimit() {
    return { minDelay: 30000, maxRandomDelay: 300000 };
  }

  /**
  * Get the prices
  * @returns {(Promise.[priceInfo])}
  * @property {string} [biddingZone] - e.g. '132733/137/17'
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
      start.setMinutes(0);
      start.setSeconds(0);
      start.setMilliseconds(0);
      end.setMinutes(0);
      end.setSeconds(0);
      end.setMilliseconds(0);

      const res = await this._getEEXPrices(start, end, zone);
      if (!res || !res[0] || !res[0].date) throw Error('no gas price info found');

      // make array with concise info per day in euro / 1000 m3 gas
      const priceInfo = res
        .filter((info) => info.descr === zone)
        .map((day) => {
          const dayStart = new Date(day.date.setHours(0));
          const timeZoneOffset = new Date(dayStart.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })) - dayStart;
          dayStart.setMilliseconds(-timeZoneOffset); // convert date CET/CEST to UTC
          const time = new Date(dayStart.getTime() + (6 * 60 * 60 * 1000)); // add 6 hours
          return {
            time,
            price: day.rawPrice * 9.7694,
          };
        })
        .filter((day) => day.time >= new Date(start - 24 * 60 * 60 * 1000)); // filter out too old days; // [];

      // pad info to fill all hours in a day
      const [lastPriceHour] = priceInfo.slice(-1);
      const endTime = new Date(lastPriceHour.time);
      endTime.setDate(endTime.getDate() + 1); // add a day, knows about DST I hope...
      endTime.setHours(endTime.getHours() - 1);
      priceInfo.push({
        time: endTime,
        price: lastPriceHour.price,
      });

      let info = padMissingHours(priceInfo);

      info = info // remove out of bounds data
        .filter((hourInfo) => hourInfo.time >= start)
        .filter((hourInfo) => hourInfo.time < end);
      return Promise.resolve(info);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(url, options, retries = 1) {
    const res = await fetch(url, options);
    this.lastResponse = res.status;

    if (!res.ok) {
      if (res.status === 429 && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this._makeRequest(url, options, retries - 1);
      }

      throw new Error(`HTTP request Failed. Status Code: ${res.status}`);
    }

    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(`Expected json but received ${contentType}: ${text.slice(0, 100)}`);
    }

    return res.json();
  }

  async _getEEXPrices(start, end, zone) {
    try {
      this.tmpZone = zone;
      const start2 = new Date(start);
      start2.setDate(start.getDate() - 7); // start earlier to make sure weekend is fetched
      const startDateStr = start2.toISOString().split('T')[0];
      const endDateStr = end.toISOString().split('T')[0];

      const areaMap = {
        TTF: 'TTF',
        CEGH: 'CEGHVTP',
        CZ: 'CZVTP',
        ETF: 'ETF',
        FIN: 'FIN',
        LTU: 'LTU',
        LVA: 'LVA-EST',
        THE: 'THE',
        PEG: 'PEG',
        ZTP: 'ZTP',
        PVB: 'PVB',
        NBP: 'NBP',
      };

      let area = 'TTF';
      for (const [key, val] of Object.entries(areaMap)) {
        if (zone.includes(key)) {
          area = val;
          break;
        }
      }

      let pricing = 'S';
      let product = 'DA';
      let displayArea = area;
      if (area === 'CEGHVTP') displayArea = 'CEGH VTP';
      if (area === 'CZVTP') displayArea = 'CZ VTP';

      let shortCode = area + product; // e.g. TTFDA

      if (zone.includes('EGSI')) {
        pricing = 'I'; // Index pricing
        product = 'EGSI';
        shortCode = `EEX EGSI ${displayArea} Day`;
      }
      const query = new URLSearchParams({
        shortCode,
        commodity: 'NATGAS',
        pricing,
        area,
        product,
        isRolling: 'true',
        startDate: startDateStr,
        endDate: endDateStr,
      }).toString();

      const url = `https://${this.host}/pub/market-data/table-data?${query}`;
      const options = {
        headers: {
          accept: 'application/json',
          origin: 'https://www.eex.com',
          referer: 'https://www.eex.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        method: 'GET',
        timeout: this.timeout,
      };

      const respJSON = await this._makeRequest(url, options);
      if (!respJSON || !respJSON.data || !Array.isArray(respJSON.data)) throw Error('Invalid info');

      const resp = [];
      let deliveryIdx = 5;
      let priceIdx = 4;
      if (respJSON.header) {
        deliveryIdx = respJSON.header.indexOf('deliveryDay');
        if (deliveryIdx === -1) deliveryIdx = 5;

        priceIdx = respJSON.header.indexOf('settlPx');
        if (priceIdx === -1) priceIdx = respJSON.header.indexOf('close');
        if (priceIdx === -1) priceIdx = respJSON.header.indexOf('lastPrice');
        if (priceIdx === -1) priceIdx = 4;
      }

      respJSON.data.forEach((row) => {
        const deliveryStr = row[deliveryIdx];
        const price = row[priceIdx];

        if (deliveryStr && price !== null && price !== undefined) {
          const numPrice = Number(price);
          if (!Number.isNaN(numPrice)) {
            const [yyyy, mm, dd] = deliveryStr.split('-');
            const date = new Date(yyyy, mm - 1, dd, 0, 0, 0); // Local midnight
            resp.push({
              date,
              rawPrice: numPrice,
              descr: this.tmpZone,
            });
          }
        }
      });

      // Fetch Weekend Info (Graceful fallback if fails)
      const queryWE = new URLSearchParams({
        shortCode: zone.includes('EGSI') ? `EEX EGSI ${displayArea} Weekend` : `${area}WE`,
        commodity: 'NATGAS',
        pricing,
        area,
        product: zone.includes('EGSI') ? 'EGSI' : 'WE',
        isRolling: 'true',
        startDate: startDateStr,
        endDate: endDateStr,
      }).toString();
      const urlWE = `https://${this.host}/pub/market-data/table-data?${queryWE}`;

      try {
        const respWE = await this._makeRequest(urlWE, options);
        if (respWE && respWE.data && Array.isArray(respWE.data)) {
          let weDeliveryIdx = 5;
          let wePriceIdx = 4;
          if (respWE.header) {
            weDeliveryIdx = respWE.header.indexOf('deliveryDay');
            if (weDeliveryIdx === -1) weDeliveryIdx = 5;

            wePriceIdx = respWE.header.indexOf('settlPx');
            if (wePriceIdx === -1) wePriceIdx = respWE.header.indexOf('close');
            if (wePriceIdx === -1) wePriceIdx = respWE.header.indexOf('lastPrice');
            if (wePriceIdx === -1) wePriceIdx = 4;
          }

          respWE.data.forEach((row) => {
            const deliveryStr = row[weDeliveryIdx];
            const price = row[wePriceIdx];

            if (deliveryStr && price !== null && price !== undefined) {
              const numPrice = Number(price);
              if (!Number.isNaN(numPrice)) {
                const [yyyy, mm, dd] = deliveryStr.split('-');
                const date = new Date(yyyy, mm - 1, dd, 0, 0, 0);
                if (!resp.some((r) => r.date.getTime() === date.getTime())) {
                  resp.push({
                    date,
                    rawPrice: numPrice,
                    descr: this.tmpZone,
                  });
                  if (date.getDay() === 6) {
                    const sunDate = new Date(date);
                    sunDate.setDate(sunDate.getDate() + 1);
                    if (!resp.some((r) => r.date.getTime() === sunDate.getTime())) {
                      resp.push({
                        date: sunDate,
                        rawPrice: numPrice,
                        descr: this.tmpZone,
                      });
                    }
                  }
                }
              }
            }
          });
        }
      } catch (e) {
        // Ignore WE fetch errors
      }

      resp.sort((a, b) => a.date - b.date);

      return Promise.resolve(resp);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

module.exports = EEX;
