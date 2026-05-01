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

const defaultHost = 'api.energyzero.nl';
const defaultTimeout = 60000;
const apiPath = '/v1/energyprices'; // gas day-ahead

const biddingZones = {
  TTF_EnergyZero: 'TTF_EnergyZero',
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

// Represents a session to the EnergyZero API.
class Energyzero extends PriceProvider {

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

  getRateLimit() {
    return { minDelay: 30000, maxRandomDelay: 300000 };
  }

  async getPrices(options) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      const opts = options || {};
      const start = opts.dateStart ? new Date(opts.dateStart) : today;
      const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;

      const query = {
        fromDate: start.toISOString(),
        tillDate: end.toISOString(),
        interval: 4, // 4 = Gas (Daily change at 06:00 CET)
        usageType: 2, // 2 = Gas
        inclBtw: false,
      };
      const qs = new URLSearchParams(query).toString();
      const path = `${apiPath}?${qs}`;
      const url = `https://${this.host}${path}`;

      const res = await fetch(url, { method: 'GET', timeout: this.timeout });
      this.lastResponse = res.status;
      if (!res.ok) throw new Error(`HTTP request Failed. Status Code: ${res.status}`);

      const data = await res.json();
      if (!data || !data.Prices) throw Error('no gas price info found');

      // EasyEnergy multiplied by 1000. Let's do the same to maintain the same format output
      let info = data.Prices.map((hourInfo) => ({ time: new Date(hourInfo.readingDate), price: hourInfo.price * 1000 }));
      info = padMissingHours(info);
      info = info
        .filter((hourInfo) => hourInfo.time >= start)
        .filter((hourInfo) => hourInfo.time <= end);

      return Promise.resolve(info);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

module.exports = Energyzero;
