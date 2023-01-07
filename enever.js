/*
Copyright 2019 - 2023, Robin de Gruijter (gruijter@hotmail.com)

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

const defaultHost = 'enever.nl';
const defaultPort = 443;
const defaultTimeout = 30000;

const biddingZones = {
	TTF_EOD: '132733/137/17',
	TTF_EGSI: '132735/139/17',
};

// mapping for enever page,
const biddingZonesMap = {
	'132733/137/17': 'prijsEOD',
	'132735/139/17': 'prijsEGSI',
};

class Enever {
	// Represents a session to the Enever API.
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

			const path = '/feed/gasprijs_laatste30dagen.php';
			const res = await this._makeRequest(path, '');
			if (!res || !res.data || !res.data[0] || !res.data[0].datum) throw Error('no gas price info found');

			// make array with concise info per day in euro / 1000 m3 gas
			const priceInfo = res.data.map((day) => {
				// const tariffStart = new Date(new Date(day.datum).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
				const tariffStart = new Date(day.datum);
				const timeZoneOffset = new Date(tariffStart.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })) - tariffStart;
				tariffStart.setMilliseconds(-timeZoneOffset); // convert date CET/CEST to UTC
				return {
					tariffStart,
					price: day[biddingZonesMap[zone]] * 1000,
					descr: biddingZonesMap[zone],
					datum: day.datum,
				};
			})
				.filter((day) => day.tariffStart >= new Date(start - 24 * 60 * 60 * 1000)) // filter out too old days; // [];
				.sort((a, b) => a.tariffStart - b.tariffStart);

			// pad info to fill all hours in a day
			let info = [];
			priceInfo.forEach((day) => {
				const startTime = new Date(day.tariffStart); // always 6am CET
				const endTime = new Date(startTime);
				endTime.setDate(endTime.getDate() + 1); // add a day, knows about DST I hope...
				const time = startTime;
				while (time < endTime) {
					info.push({ time: new Date(time), price: day.price }); // push hourinfo
					time.setTime(time.getTime() + (60 * 60 * 1000)); // add an hour
				}
			});
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
			};
			const options = {
				hostname: this.host,
				port: this.port,
				path,
				headers,
				method: 'GET',
			};
			const result = await this._makeHttpsRequest(options, postMessage, timeout);
			this.lastResponse = result.body || result.statusCode;
			const contentType = result.headers['content-type'];
			// find errors
			if (result.statusCode !== 200) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
			}
			if (!/\/json/.test(contentType)) {
				const body = typeof result.body === 'string' ? result.body.slice(0, 20) : '';
				throw Error(`Expected json but received ${contentType}: ${body}`);
			}
			// console.dir(JSON.parse(result.body), { depth: null });
			return Promise.resolve(JSON.parse(result.body));
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

module.exports = Enever;

// // START TEST HERE
// const enever = new Enever({ biddingZone: '132735/139/17' });

// const today = new Date();
// today.setHours(0);
// const yesterday = new Date(today);
// const tomorrow = new Date(today);
// yesterday.setDate(yesterday.getDate() - 1);
// tomorrow.setDate(tomorrow.getDate() + 2);

// enever.getPrices({ dateStart: yesterday, dateEnd: tomorrow })
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

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

{
    "data": [
        {
            "datum": "2023-01-02 06:00:00",
            "prijsEGSI": "0.748960",
            "prijsEOD": "0.625196",
            "prijsZP": "1.548942",
            "prijsEE": "1.626869",
            "prijsFR": "1.494587",
            "prijsAIP": "1.589692",
            "prijsEZ": "1.581699",
            "prijsZG": "1.581699",
            "prijsNE": "1.581699",
            "prijsGSL": "1.581699",
            "prijsANWB": "1.581699",
            "prijsVON": "1.588440"
        },
        {
            "datum": "2023-01-01 06:00:00",
            "prijsEGSI": "0.748960",
            "prijsEOD": "0.625196",
            "prijsZP": "1.548942",
            "prijsEE": "1.626869",
            "prijsFR": "1.494587",
            "prijsAIP": "1.589692",
            "prijsEZ": "1.581699",
            "prijsZG": "1.581699",
            "prijsNE": "1.581699",
            "prijsGSL": "1.581699",
            "prijsANWB": "1.581699",
            "prijsVON": "1.588440"
        },

*/
