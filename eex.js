/* eslint-disable max-len */
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
const qs = require('querystring');
// const util = require('util');

const defaultHost = 'webservice-eex.gvsi.com'; // EOD and EGSI
const defaultPort = 443;
const defaultTimeout = 30000;

const biddingZones = {
  TTF_EOD: 'TTF_EOD',
  TTF_EGSI: 'TTF_EGSI',
  CEGH_VTP_EOD: 'CEGH_VTP_EOD',
  CEGH_VTP_EGSI: 'CEGH_VTP_EGSI',
  CZ_VTP_EOD: 'CZ_VTP_EOD',
  CZ_VTP_EGSI: 'CZ_VTP_EGSI',
  ETF_EOD: 'ETFF_EOD',
  ETF_EGSI: 'ETF_EGSI',
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

// mapping for eex page,
const biddingZonesMap = {
  TTF_EOD: '"#E.TTF_GND1"',
  CEGH_VTP_EOD: '"#E.CEGH_GND1"',
  CZ_VTP_EOD: '"#E.OTE_GSND"',
  ETF_EOD: '"#E.ETF_GND1"',
  THE_EOD: '"#E.THE_GND1"',
  PEG_EOD: '"#E.PEG_GND1"',
  ZTP_EOD: '"#E.ZTP_GTND"',
  PVB_EOD: '"#E.PVB_GSND"',
  NBP_EOD: '"#E.NBP_GPND"',

  TTF_EGSI: '"$E.EGSI_TTF_DAY"',
  CEGH_VTP_EGSI: '"$E.EGSI_CEHG_VTP_DAY"',
  CZ_VTP_EGSI: '"$E.EGSI_CZ_VTP"',
  ETF_EGSI: '"$E.EGSI_ETF_DAY"',
  THE_EGSI: '"$E.EGSI_THE_DAY"',
  PEG_EGSI: '"$E.EGSI_PEG_DAY"',
  ZTP_EGSI: '"$E.EGSI_ZTP_DAY"',
  PVB_EGSI: '"$E.EGSI_PVB_DAY"',
  NBP_EGSI: '"$E.EGSI_NBP_DAY"',
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
class EEX {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.port = options.port || defaultPort;
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

      let path = '';
      this.tmpZone = zone;
      const start2 = new Date(start);
      start2.setDate(start.getDate() - 1); // start earlier to make sure weekend is fetched
      const [chartstartdate] = start2.toISOString().split('T'); // '2022-11-30'
      const [chartstopdate] = end.toISOString().split('T'); // '2023-01-15'
      const priceSymbol = biddingZonesMap[zone]; // '"#E.TTF_GND1"' // "#E.EGSI_TTF_DAY" // weekend: '"#E.TTF_GWE1"' "#E.EGSI_TTF_WEEKEND"
      const query = qs.stringify({
        priceSymbol,
        chartstartdate,
        chartstopdate,
        // dailybarinterval: 'Days',
        // aggregatepriceselection: 'First',
      });
      path = `/query/json/getDaily/close/tradedatetimegmt/?${query}`;
      // path = `/query/json/getDaily/close/onexchtradevolumeeex/tradedatetimegmt/?${query}`;

      const res = await this._makeRequest(path, '');
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

  async _makeRequest(path, postMessage, timeout) {
    try {
      const headers = {
        'content-type': 'application/json',
        Origin: 'https://www.eex.com',
        Referer: 'https://www.eex.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        Connection: 'keep-alive',
      };
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        headers,
        method: 'GET',
      };
      // console.log(options);
      const result = await this._makeHttpsRequest(options, postMessage, timeout);
      this.lastResponse = result.body || result.statusCode;
      const contentType = result.headers['content-type'];
      // find errors
      if (result.statusCode !== 200) {
        this.lastResponse = result.statusCode;
        throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
      }
      if (headers['content-type'] !== contentType) {
        const body = typeof result.body === 'string' ? result.body.slice(0, 20) : '';
        throw Error(`Expected ${headers['content-type']} but received ${contentType}: ${body}`);
      }

      // console.log(contentType, result.body);

      // parse JSON
      if (contentType.includes('json')) {
        // parse daily info
        const respJSON = JSON.parse(result.body);
        if (!respJSON.results || !respJSON.results.items) throw Error('Invalid info');
        const dailyInfo = respJSON.results.items;
        const lastDaily = dailyInfo.slice(-1)[0]; // {close:55.665, onexchtradevolumeeex:3277272, tradedatetimegmt:'1/16/2023 12:00:00 PM'}
        // console.dir(dailyInfo, { depth: null });
        // console.dir(lastDaily, { depth: null });

        // compensate for bug in EEX
        if (this.lastDailyInfo) {
          dailyInfo.forEach((dayInfo, index) => {
            if ((index > dailyInfo.length - 4) && (index < dailyInfo.length - 1)) {
              const previousInfo = this.lastDailyInfo.find((lastDayInfo) => lastDayInfo.tradedatetimegmt === dayInfo.tradedatetimegmt);
              if (previousInfo && previousInfo.close !== dayInfo.close) {
                // console.log('need to compensate!', dailyInfo, previousInfo);
                dailyInfo[index].close = previousInfo.close;
              }
            }
          });
        }
        this.lastDailyInfo = [...dailyInfo];

        // fetch weekend info ONLY FOR EOD (not EGSI)
        let weekendInfo;
        if (this.tmpZone.includes('EOD')) {
          options.path = options.path.replace('ND', 'WE');
          options.path = options.path.replace('DAY', 'WEEKEND');
          const resultW = await this._makeHttpsRequest(options, postMessage, timeout);
          const respWJSON = JSON.parse(resultW.body);
          weekendInfo = respWJSON.results && respWJSON.results.items;
        }

        // fetch today settle
        const priceSymbol = biddingZonesMap[this.tmpZone]; // '"#E.TTF_GND1"' // weekend: '"#E.TTF_GWE1"'
        const query = qs.stringify({ priceSymbol });
        options.path = `/query/json/getQuotes/settledate/dir/?${query}`;
        const resultSettle = await this._makeHttpsRequest(options, postMessage, timeout);
        const respSettle = JSON.parse(resultSettle.body); // { settledate: '1/16/2023', dir: 55.25 } || { settledate: null, dir: 55.25 }
        const lastSettleDate = respSettle.results && respSettle.results.items
          && respSettle.results.items[0] && respSettle.results.items[0].settledate;

        // check if lastDaily is settled (closed)
        const lastDailyIsClosed = lastDaily.tradedatetimegmt && (lastDaily.tradedatetimegmt.split(' ')[0] === lastSettleDate);

        // create array with daily values
        const resp = [];
        dailyInfo.forEach((day, idx) => { // { close: 55.665, onexchtradevolumeeex: 3277272, tradedatetimegmt: '1/16/2023 12:00:00 PM' }
          const date = new Date(day.tradedatetimegmt.split(' ')[0]);
          date.setDate(date.getDate() + 1); // is day ahead, duh...
          let mappedDay = {
            date,
            rawPrice: Number(day.close),
            descr: this.tmpZone,
          };

          // Check if last daily entry is closed // after 20:00 CET?
          if ((idx === dailyInfo.length - 1)
            && mappedDay.date.getDay() !== 6 // is actually price for monday after the weekend
            && !lastDailyIsClosed) mappedDay = null; // ignore last day info because it is not closed yet

          // Check if last entry is weekend info, and is closed
          if (weekendInfo && mappedDay && mappedDay.date.getDay() === 6) {
            // console.log('it is weekend');
            const [weekend] = weekendInfo.filter((dayW) => dayW.tradedatetimegmt === day.tradedatetimegmt);
            const satTime = new Date(weekend.tradedatetimegmt.split(' ')[0]);
            satTime.setDate(satTime.getDate() + 1); // is day ahead, duh...
            const sat = {
              date,
              rawPrice: Number(weekend.close),
              descr: this.tmpZone,
            };
            const sun = { ...sat };
            sun.date = new Date(sun.date);
            sun.date.setDate(sun.date.getDate() + 1); // add a day, knows about DST I hope...
            const mon = { ...mappedDay };
            mon.date = new Date(mon.date);
            mon.date.setDate(mon.date.getDate() + 2); // add a weekend, knows about DST I hope...
            resp.push(sat, sun, mon); // add weekend and monday
            mappedDay = null; // skipp adding normal weekday info
          }

          // Add normal weekday info
          if (mappedDay) resp.push(mappedDay);
        });
        // console.dir(resp, { depth: null });
        // console.dir(resp.filter((info) => info.descr === this.biddingZone), { depth: null });
        return Promise.resolve(resp);
      }

      throw Error(`No XML or JSON received: ${contentType}`);
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

module.exports = EEX;

// // START TEST HERE
// const test = async () => {
//   const next = new EEX({ biddingZone: 'TTF_EGSI' }); // 'TTF_EOD'

//   // next.lastDailyInfo = [
//   //  {
//   //   close: 59.83,
//   //   onexchtradevolumeeex: 3369840,
//   //   tradedatetimegmt: '1/16/2023 12:00:00 PM',
//   //  },
//   //  {
//   //   close: 59.83,
//   //   onexchtradevolumeeex: 3679632,
//   //   tradedatetimegmt: '1/17/2023 12:00:00 PM',
//   //  },
//   //  {
//   //   close: 60.01,
//   //   onexchtradevolumeeex: 3719736,
//   //   tradedatetimegmt: '1/18/2023 12:00:00 PM',
//   //  },
//   //  {
//   //   close: 61.271,
//   //   onexchtradevolumeeex: 3815928,
//   //   tradedatetimegmt: '1/19/2023 12:00:00 PM',
//   //  },
//   //  {
//   //   close: 62.125,
//   //   onexchtradevolumeeex: 554952,
//   //   tradedatetimegmt: '1/20/2023 12:00:00 PM',
//   //  },
//   // ];

//   const today = new Date();
//   today.setHours(0);
//   const yesterday = new Date(today);
//   const tomorrow = new Date(today);
//   yesterday.setDate(yesterday.getDate() - 1);
//   tomorrow.setDate(tomorrow.getDate() + 3);

//   const result = await next.getPrices({ dateStart: yesterday, dateEnd: tomorrow }).catch((error) => console.log(error));
//   console.dir(result, { depth: null });
//   // const result2 = await next.getPrices({ dateStart: '2024-04-06T22:00:00.000Z', dateEnd: '2024-04-08T22:00:00.000Z' }).catch((error) => console.log(error));
//   // console.dir(result2, { depth: null });
// };

// test();

/*
[
  { time: 2022-12-13T23:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T00:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T01:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T02:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T03:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T04:00:00.000Z, price: 1344.6309078 },
  { time: 2022-12-14T05:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T06:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T07:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T08:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T09:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T10:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T11:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T12:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T13:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T14:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T15:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T16:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T17:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T18:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T19:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T20:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T21:00:00.000Z, price: 1348.5972841999999 },
  { time: 2022-12-14T22:00:00.000Z, price: 1348.5972841999999 }
]

today:
https://webservice-eex.gvsi.com/query/json/getQuotes/ontradeprice/onexchsingletradevolume/close/onexchtradevolumeeex/?priceSymbol=%22%23E.TTF_GND1%22
close: null
onexchsingletradevolume: 1200
onexchtradevolumeeex: 307728
ontradeprice: 56.7

today graph: results.items
https://webservice-eex.gvsi.com/query/json/getQuotes/settledate/dir/?priceSymbol=%22%23E.TTF_GND1%22
dir: 56.75
settledate: null

all graph: results.item
https://webservice-eex.gvsi.com/query/json/getDaily/close/onexchtradevolumeeex/tradedatetimegmt/?priceSymbol=%22%23E.TTF_GND1%22&chartstartdate=2022%2F12%2F01&chartstopdate=2023%2F01%2F16&dailybarinterval=Days&aggregatepriceselection=First
close: 56.75
onexchtradevolumeeex: 324264
tradedatetimegmt: "1/16/2023 12:00:00 PM"

*/
