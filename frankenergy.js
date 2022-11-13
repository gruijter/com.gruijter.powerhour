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

const defaultHost = 'graphcdn.frankenergie.nl'; // 'frank-graphql-prod.graphcdn.app'
const defaultPort = 443;
const defaultTimeout = 30000;

class Frank {
	// Represents a session to the FrankEnergy API.
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
			const tomorrow = new Date(today);
			tomorrow.setDate(today.getDate() + 1);

			const opts = options || {};
			const start = opts.dateStart ? new Date(opts.dateStart) : today;
			const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
			start.setMinutes(0);
			start.setSeconds(0);
			start.setMilliseconds(0);
			end.setMinutes(0);
			end.setSeconds(0);
			end.setMilliseconds(0);

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
			let start = new Date(day);
			start.setMinutes(0);
			start.setSeconds(0);
			start.setMilliseconds(0);
			let end = new Date(start);
			end.setDate(end.getDate() + 1);

			// convert to NL timezone for API request
			start = new Date(start.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
			end = new Date(end.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));

			const startDate = `${start.getFullYear()}-${(start.getMonth() + 1).toString().padStart(2, '0')}`	// '2022-03-18'
				+ `-${start.getDate().toString().padStart(2, '0')}`;
			const endDate = `${end.getFullYear()}-${(end.getMonth() + 1).toString().padStart(2, '0')}-${end.getDate().toString().padStart(2, '0')}`;
			const query = `query MarketPrices {
				marketPricesGas(startDate: "${startDate}", endDate: "${endDate}") {
				from
				till
				marketPrice
				}
			}`;
			const path = '/';
			const res = await this._makeRequest(path, JSON.stringify({ query }));
			if (!res || !res.data || !res.data.marketPricesGas) throw Error('no gas price info found');
			// make array with concise info per day in euro / 1000 m3 gas
			const prices = res.data.marketPricesGas.map((hour) => hour.marketPrice * 1000);
			const timeInterval = {
				start: res.data.marketPricesGas[0].from,
				end: res.data.marketPricesGas.pop().till,
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
				'content-type': 'application/json',
			};
			const options = {
				hostname: this.host,
				port: this.port,
				path,
				headers,
				method: 'POST',
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

module.exports = Frank;

// // START TEST HERE
// const frank = new Frank();

// const today = new Date();
// today.setHours(0);
// const yesterday = new Date(today);
// const tomorrow = new Date(today);
// yesterday.setDate(yesterday.getDate() - 1);
// tomorrow.setDate(tomorrow.getDate() + 1);

// frank.getPrices({ dateStart: today, dateEnd: tomorrow })
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

/*

[
	{
		timeInterval: {
			start: '2022-03-17T23:00:00.000Z',
			end: '2022-03-18T23:00:00.000Z'
		},
		prices: [
			951.73, 951.73, 951.73,
			951.73, 951.73, 951.73,
			997.62, 997.62, 997.62,
			997.62, 997.62, 997.62,
			997.62, 997.62, 997.62,
			997.62, 997.62, 997.62,
			997.62, 997.62, 997.62,
			997.62, 997.62, 997.62
		]
	},
	{
		timeInterval: {
			start: '2022-03-18T23:00:00.000Z',
			end: '2022-03-19T05:00:00.000Z'
		},
		prices: [ 997.62, 997.62, 997.62, 997.62, 997.62, 997.62 ]
	}
]

{
	data: {
		marketPricesElectricity: [
			{
				till: '2022-03-18T00:00:00.000Z',
				from: '2022-03-17T23:00:00.000Z',
				marketPrice: 0.20303,
				priceIncludingMarkup: 0.34397
			},
			{
				till: '2022-03-18T01:00:00.000Z',
				from: '2022-03-18T00:00:00.000Z',
				marketPrice: 0.20697,
				priceIncludingMarkup: 0.34873
			},
			{
				till: '2022-03-18T02:00:00.000Z',
				from: '2022-03-18T01:00:00.000Z',
				marketPrice: 0.23055,
				priceIncludingMarkup: 0.37727
			},
			{
				till: '2022-03-18T03:00:00.000Z',
				from: '2022-03-18T02:00:00.000Z',
				marketPrice: 0.2065,
				priceIncludingMarkup: 0.34817
			},
			{
				till: '2022-03-18T04:00:00.000Z',
				from: '2022-03-18T03:00:00.000Z',
				marketPrice: 0.2099,
				priceIncludingMarkup: 0.35228
			},
			{
				till: '2022-03-18T05:00:00.000Z',
				from: '2022-03-18T04:00:00.000Z',
				marketPrice: 0.21706,
				priceIncludingMarkup: 0.36094
			},
			{
				till: '2022-03-18T06:00:00.000Z',
				from: '2022-03-18T05:00:00.000Z',
				marketPrice: 0.26297,
				priceIncludingMarkup: 0.41649
			},
			{
				till: '2022-03-18T07:00:00.000Z',
				from: '2022-03-18T06:00:00.000Z',
				marketPrice: 0.29151,
				priceIncludingMarkup: 0.45103
			},
			{
				till: '2022-03-18T08:00:00.000Z',
				from: '2022-03-18T07:00:00.000Z',
				marketPrice: 0.28781,
				priceIncludingMarkup: 0.44655
			},
			{
				till: '2022-03-18T09:00:00.000Z',
				from: '2022-03-18T08:00:00.000Z',
				marketPrice: 0.23979,
				priceIncludingMarkup: 0.38845
			},
			{
				till: '2022-03-18T10:00:00.000Z',
				from: '2022-03-18T09:00:00.000Z',
				marketPrice: 0.2096,
				priceIncludingMarkup: 0.35192
			},
			{
				till: '2022-03-18T11:00:00.000Z',
				from: '2022-03-18T10:00:00.000Z',
				marketPrice: 0.19367,
				priceIncludingMarkup: 0.33264
			},
			{
				till: '2022-03-18T12:00:00.000Z',
				from: '2022-03-18T11:00:00.000Z',
				marketPrice: 0.19742,
				priceIncludingMarkup: 0.33718
			},
			{
				till: '2022-03-18T13:00:00.000Z',
				from: '2022-03-18T12:00:00.000Z',
				marketPrice: 0.19718,
				priceIncludingMarkup: 0.33689
			},
			{
				till: '2022-03-18T14:00:00.000Z',
				from: '2022-03-18T13:00:00.000Z',
				marketPrice: 0.2001,
				priceIncludingMarkup: 0.34042
			},
			{
				till: '2022-03-18T15:00:00.000Z',
				from: '2022-03-18T14:00:00.000Z',
				marketPrice: 0.19997,
				priceIncludingMarkup: 0.34026
			},
			{
				till: '2022-03-18T16:00:00.000Z',
				from: '2022-03-18T15:00:00.000Z',
				marketPrice: 0.20703,
				priceIncludingMarkup: 0.34881
			},
			{
				till: '2022-03-18T17:00:00.000Z',
				from: '2022-03-18T16:00:00.000Z',
				marketPrice: 0.24554,
				priceIncludingMarkup: 0.3954
			},
			{
				till: '2022-03-18T18:00:00.000Z',
				from: '2022-03-18T17:00:00.000Z',
				marketPrice: 0.27531,
				priceIncludingMarkup: 0.43143
			},
			{
				till: '2022-03-18T19:00:00.000Z',
				from: '2022-03-18T18:00:00.000Z',
				marketPrice: 0.28652,
				priceIncludingMarkup: 0.44499
			},
			{
				till: '2022-03-18T20:00:00.000Z',
				from: '2022-03-18T19:00:00.000Z',
				marketPrice: 0.2499,
				priceIncludingMarkup: 0.40068
			},
			{
				till: '2022-03-18T21:00:00.000Z',
				from: '2022-03-18T20:00:00.000Z',
				marketPrice: 0.21694,
				priceIncludingMarkup: 0.3608
			},
			{
				till: '2022-03-18T22:00:00.000Z',
				from: '2022-03-18T21:00:00.000Z',
				marketPrice: 0.2285,
				priceIncludingMarkup: 0.37479
			},
			{
				till: '2022-03-18T23:00:00.000Z',
				from: '2022-03-18T22:00:00.000Z',
				marketPrice: 0.18693,
				priceIncludingMarkup: 0.32449
			}
		],
		marketPricesGas: [
			{
				from: '2022-03-17T23:00:00.000Z',
				till: '2022-03-18T00:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T00:00:00.000Z',
				till: '2022-03-18T01:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T01:00:00.000Z',
				till: '2022-03-18T02:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T02:00:00.000Z',
				till: '2022-03-18T03:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T03:00:00.000Z',
				till: '2022-03-18T04:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T04:00:00.000Z',
				till: '2022-03-18T05:00:00.000Z',
				marketPrice: 0.95173,
				priceIncludingMarkup: 1.79259
			},
			{
				from: '2022-03-18T05:00:00.000Z',
				till: '2022-03-18T06:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T06:00:00.000Z',
				till: '2022-03-18T07:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T07:00:00.000Z',
				till: '2022-03-18T08:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T08:00:00.000Z',
				till: '2022-03-18T09:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T09:00:00.000Z',
				till: '2022-03-18T10:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T10:00:00.000Z',
				till: '2022-03-18T11:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T11:00:00.000Z',
				till: '2022-03-18T12:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T12:00:00.000Z',
				till: '2022-03-18T13:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T13:00:00.000Z',
				till: '2022-03-18T14:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T14:00:00.000Z',
				till: '2022-03-18T15:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T15:00:00.000Z',
				till: '2022-03-18T16:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T16:00:00.000Z',
				till: '2022-03-18T17:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T17:00:00.000Z',
				till: '2022-03-18T18:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T18:00:00.000Z',
				till: '2022-03-18T19:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T19:00:00.000Z',
				till: '2022-03-18T20:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T20:00:00.000Z',
				till: '2022-03-18T21:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T21:00:00.000Z',
				till: '2022-03-18T22:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			},
			{
				from: '2022-03-18T22:00:00.000Z',
				till: '2022-03-18T23:00:00.000Z',
				marketPrice: 0.99762,
				priceIncludingMarkup: 1.84812
			}
		]
	}
}

*/
