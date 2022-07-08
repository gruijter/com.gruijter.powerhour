/*
Copyright 2019 - 2022, Robin de Gruijter (gruijter@hotmail.com)

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
const defaultTimeout = 30000;
const lebaPath = '/nl/api/tariff/getlebatariffs'; // gas LEBA ETF day-ahead
// const apxPath = '/nl/api/tariff/getapxtariffs'; // electricity ETF day-ahead

class Easyenergy {
	// Represents a session to the Easyenergy API.
	constructor(opts) {
		const options = opts || {};
		this.host = options.host || defaultHost;
		this.port = options.port || defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.lastResponse = undefined;
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

			const info = [];
			const day = start;
			while (day <= end) {
				// eslint-disable-next-line no-await-in-loop
				const infoDay = await this.getPricesDay(day).catch((error) => error);
				info.push(infoDay);
				day.setDate(day.getDate() + 1);
			}
			// console.dir(info, { depth: null });
			const infoGood = info.filter((infoDay) => !(infoDay instanceof Error));
			if (infoGood.length === 0) throw info.find((infoDay) => infoDay instanceof Error);
			return Promise.resolve(infoGood);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getPricesDay(day) {
		try {
			const start = new Date(day);
			// start.setHours(0); // doesnt work with Homey time
			start.setMinutes(0);
			start.setSeconds(0);
			start.setMilliseconds(0);
			const end = new Date(start);
			end.setDate(end.getDate() + 1);

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
			const prices = res.map((hour) => hour.TariffUsage * 1000);
			const timeInterval = {
				start: new Date(res[0].Timestamp).toISOString(),
				end: new Date(res.pop().Timestamp).toISOString(),
			};
			const info = {
				timeInterval,
				prices,
			};
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

// START TEST HERE
// const easyEnergy = new Easyenergy();

// const today = new Date();
// today.setHours(0);
// const yesterday = new Date(today);
// const tomorrow = new Date(today);
// yesterday.setDate(yesterday.getDate() - 1);
// tomorrow.setDate(tomorrow.getDate() + 1);

// const dateStart = '2022-07-09T22:00:00.000Z';
// const dateEnd = '2022-07-09T22:00:00.000Z';
// easyEnergy.getPrices({ dateStart, dateEnd })

// // easyEnergy.getPrices({ dateStart: today, dateEnd: tomorrow })
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

/*

[
	{
		timeInterval: {
			start: '2022-05-26T22:00:00.000Z',
			end: '2022-05-27T21:00:00.000Z'
		},
		prices: [
							 968.9922,          968.9922,
							 968.9922,          968.9922,
							 968.9922,          968.9922,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001,
			979.3498000000001, 979.3498000000001
		]
	},
	{
		timeInterval: {
			start: '2022-05-27T22:00:00.000Z',
			end: '2022-05-28T03:00:00.000Z'
		},
		prices: [
			979.3498000000001,
			979.3498000000001,
			979.3498000000001,
			979.3498000000001,
			979.3498000000001,
			979.3498000000001
		]
	}
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
