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

const defaultHost = 'mijn.easyenergy.com';
const defaultPort = 443;
const defaultTimeout = 60000;
const lebaPath = '/nl/api/tariff/getlebatariffs'; // gas LEBA TTF day-ahead
// const apxPath = '/nl/api/tariff/getapxtariffs'; // electricity TTF day-ahead

const biddingZones = {
	TTF_LEBA_EasyEnergy: 'TTF_LEBA_EasyEnergy',
};

class Easyenergy {
	// Represents a session to the Easyenergy API.
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
				// grouping: '', // defaults to by hour?
				includeVat: false,
			};
			const qs = new URLSearchParams(query).toString();
			const path = `${lebaPath}?${qs}`;
			const res = await this._makeRequest(path);
			if (!res || !res[0] || !res[0].Timestamp) throw Error('no gas price info found');

			// make array with concise info per day in euro / 1000 m3 gas
			const info = res
				.map((hourInfo) => ({ time: new Date(hourInfo.Timestamp), price: hourInfo.TariffUsage * 1000 }))
				.filter((hourInfo) => hourInfo.time >= start) // remove out of bounds data
				.filter((hourInfo) => hourInfo.time <= end);

			return Promise.resolve(info);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(path, postMessage, timeout) {
		try {
			const headers = {
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
			if (!/\/json/.test(contentType)) {
				throw Error(`Expected json but received ${contentType}: ${result.body}`);
			}
			// find errors
			if (result.statusCode !== 200) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
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

module.exports = Easyenergy;

// // START TEST HERE
// const easyEnergy = new Easyenergy();

// // const today = new Date();
// // today.setHours(0);
// // const yesterday = new Date(today);
// // const tomorrow = new Date(today);
// // yesterday.setDate(yesterday.getDate() - 1);
// // tomorrow.setDate(tomorrow.getDate() + 1);

// const dateStart = '2023-01-01T23:00:00.000Z';
// const dateEnd = '2023-01-02T23:00:00.000Z';
// easyEnergy.getPrices({ dateStart, dateEnd })

// // easyEnergy.getPrices({ dateStart: today, dateEnd: tomorrow })
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

/*

[
  { time: 2022-12-11T23:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T00:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T01:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T02:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T03:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T04:00:00.000Z, price: 1384.8 },
  { time: 2022-12-12T05:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T06:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T07:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T08:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T09:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T10:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T11:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T12:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T13:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T14:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T15:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T16:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T17:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T18:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T19:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T20:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T21:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T22:00:00.000Z, price: 1367.84 },
  { time: 2022-12-12T23:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T00:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T01:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T02:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T03:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T04:00:00.000Z, price: 1367.84 },
  { time: 2022-12-13T05:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T06:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T07:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T08:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T09:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T10:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T11:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T12:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T13:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T14:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T15:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T16:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T17:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T18:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T19:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T20:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T21:00:00.000Z, price: 1343.58 },
  { time: 2022-12-13T22:00:00.000Z, price: 1343.58 }
]

[
	{
		Timestamp: '2022-05-26T22:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-26T23:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-27T00:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-27T01:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-27T02:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-27T03:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9689922,
		TariffReturn: 0.9689922
	},
	{
		Timestamp: '2022-05-27T04:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T05:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T06:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T07:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T08:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T09:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T10:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T11:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T12:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T13:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T14:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T15:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T16:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T17:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T18:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T19:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T20:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	},
	{
		Timestamp: '2022-05-27T21:00:00+00:00',
		SupplierId: 0,
		TariffUsage: 0.9793498,
		TariffReturn: 0.9793498
	}
]
*/
