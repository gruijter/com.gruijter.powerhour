'use strict';

const PriceProvider = require('./PriceProvider');

const defaultHost = 'mijn.easyenergy.com';
const defaultTimeout = 60000;
const lebaPath = '/nl/api/tariff/getlebatariffs'; // gas LEBA TTF day-ahead

const biddingZones = {
  TTF_LEBA_EasyEnergy: 'TTF_LEBA_EasyEnergy',
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

// Represents a session to the Easyenergy API.
class Easyenergy extends PriceProvider {

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
  * Get the prices
  * @returns {(Promise.[priceInfo])}
  * @property {string} [dateStart = today] - date Object or date string, e.g. '2022-02-21T20:36:10.665Z'
  * @property {string} [dateEnd = tomorrow ] - date Object or date string, e.g. '2022-02-21T20:36:10.665Z'
  */
  async getPrices(options) {
    try {
      const today = new Date();
      today.setHours(0);
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      const opts = options || {};
      const start = opts.dateStart ? new Date(opts.dateStart) : today;
      const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;

      const query = {
        startTimestamp: start.toISOString(),
        endTimestamp: end.toISOString(),
        includeVat: false,
      };
      const qs = new URLSearchParams(query).toString();
      const path = `${lebaPath}?${qs}`;
      const res = await this._makeRequest(path);
      if (!res || !res[0] || !res[0].Timestamp) throw Error('no gas price info found');

      let info = res.map((hourInfo) => ({ time: new Date(hourInfo.Timestamp), price: hourInfo.TariffUsage * 1000 }));
      info = padMissingHours(info);
      info = info
        .filter((hourInfo) => hourInfo.time >= start)
        .filter((hourInfo) => hourInfo.time <= end);

      return Promise.resolve(info);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(path, timeout) {
    try {
      const url = `https://${this.host}${path}`;
      const options = {
        method: 'GET',
        timeout: timeout || this.timeout,
      };

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      if (!result.ok) {
        throw new Error(`HTTP request Failed. Status Code: ${result.status}`);
      }

      const contentType = result.headers.get('content-type');
      if (!/application\/json/.test(contentType)) {
        const text = await result.text();
        throw new Error(`Expected json but received ${contentType}: ${text.slice(0, 100)}`);
      }
      return result.json();
    } catch (error) {
      this.lastResponse = error;
      return Promise.reject(error);
    }
  }
}

module.exports = Easyenergy;
