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

const defaultHost = 'www.powernext.com';
const defaultPort = 443;
const defaultTimeout = 30000;

const biddingZones = {
	TTF_EOD: '132733/137/17',
	TTF_EGSI: '132735/139/17',
	CEGH_VTP_EOD: '132733/137/16',
	CEGH_VTP_EGSI: '132735/139/16',
	CZ_VTP_EOD: '132733/137/458',
	CZ_VTP_EGSI: '132735/139/458',
	VTF_EOD: '132733/137/20',
	VTF_EGSI: '132735/139/20',
	THE_EOD: '132733/137/558',
	THE_EGSI: '132735/139/558',
	PEG_EOD: '132733/137/516',
	PEG_EGSI: '132735/139/516',
	ZTP_EOD: '132733/137/48',
	ZTP_EGSI: '132735/139/48',
	PVB_EOD: '132733/137/525',
	PVB_EGSI: '132735/139/525',
};

class PowerNext {
	// Represents a session to the PowerNext API.
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

			const path = `/data-feed/${zone}`;
			const res = await this._makeRequest(path, '');
			if (!res || !res.values || !res.values[0] || !res.values[0].data) throw Error('no gas price info found');

			// make array with concise info per day in euro / 1000 m3 gas
			const priceInfo = res.values[0].data.map((day) => {
				const tariffStart = new Date(day.x);
				tariffStart.setTime(tariffStart.getTime() + (6 * 60 * 60 * 1000)); // add 6 hours
				return {
					tariffStart,
					price: day.y * 9.7694,
					descr: day.name,
				};
			})
				.filter((day) => day.tariffStart >= new Date(start - 24 * 60 * 60 * 1000)); // filter out too old days; // [];

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

module.exports = PowerNext;

// // START TEST HERE
// const next = new PowerNext({ biddingZone: '132733/137/17' });

// const today = new Date();
// today.setHours(0);
// const yesterday = new Date(today);
// const tomorrow = new Date(today);
// yesterday.setDate(yesterday.getDate() - 1);
// tomorrow.setDate(tomorrow.getDate() + 2);

// next.getPrices({ dateStart: today, dateEnd: tomorrow })
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

x: start of day in CET zone > need to convert to UTC
y: price in €/MWh
WE: Weekend
DA: Day

[
  {
    time: 2022-10-29T22:00:00.000Z, >> DST
    price: 313.46096839999996,
    descr: 'WE 2022-10-29/30'
  },
  {
    time: 2022-10-30T23:00:00.000Z, >> END DST
    price: 337.630464,
    descr: 'DA 2022-10-31'
  },
  {
    time: 2022-10-31T23:00:00.000Z,
    price: 303.0760962,
    descr: 'DA 2022-11-01'
  },

{
  values: [
    {
      data: [
        { x: 1667080800000, y: 32.086, name: 'WE 2022-10-29/30' },
        { x: 1667170800000, y: 34.56, name: 'DA 2022-10-31' },
        { x: 1667257200000, y: 31.023, name: 'DA 2022-11-01' },
        { x: 1667343600000, y: 22.003, name: 'DA 2022-11-02' },
        { x: 1667430000000, y: 48.824, name: 'DA 2022-11-03' },
        { x: 1667516400000, y: 67.881, name: 'DA 2022-11-04' },
        { x: 1667602800000, y: 53.335, name: 'WE 2022-11-05/06' },
        { x: 1667689200000, y: 53.335, name: 'WE 2022-11-05/06' },
        { x: 1667775600000, y: 56.635, name: 'DA 2022-11-07' },
        { x: 1667862000000, y: 63.169, name: 'DA 2022-11-08' },
        { x: 1667948400000, y: 89.805, name: 'DA 2022-11-09' },
        { x: 1668034800000, y: 87.229, name: 'DA 2022-11-10' },
        { x: 1668121200000, y: 74.787, name: 'DA 2022-11-11' },
        { x: 1668207600000, y: 54.707, name: 'WE 2022-11-12/13' },
        { x: 1668294000000, y: 54.707, name: 'WE 2022-11-12/13' },
        { x: 1668380400000, y: 67.287, name: 'DA 2022-11-14' },
        { x: 1668466800000, y: 107.908, name: 'DA 2022-11-15' },
        { x: 1668553200000, y: 115.537, name: 'DA 2022-11-16' },
        { x: 1668639600000, y: 100.282, name: 'DA 2022-11-17' },
        { x: 1668726000000, y: 106.792, name: 'DA 2022-11-18' },
        { x: 1668812400000, y: 108.875, name: 'WE 2022-11-19/20' },
        { x: 1668898800000, y: 108.875, name: 'WE 2022-11-19/20' },
        { x: 1668985200000, y: 109.878, name: 'DA 2022-11-21' },
        { x: 1669071600000, y: 112.064, name: 'DA 2022-11-22' },
        { x: 1669158000000, y: 116.692, name: 'DA 2022-11-23' },
        { x: 1669244400000, y: 126.385, name: 'DA 2022-11-24' },
        { x: 1669330800000, y: 118.847, name: 'DA 2022-11-25' },
        { x: 1669417200000, y: 124.487, name: 'WE 2022-11-26/27' },
        { x: 1669503600000, y: 124.487, name: 'WE 2022-11-26/27' },
        { x: 1669590000000, y: 125.577, name: 'DA 2022-11-28' },
        { x: 1669676400000, y: 124.582, name: 'DA 2022-11-29' },
        { x: 1669762800000, y: 133.091, name: 'DA 2022-11-30' },
        { x: 1669849200000, y: 139.897, name: 'DA 2022-12-01' },
        { x: 1669935600000, y: 136.09, name: 'DA 2022-12-02' },
        { x: 1670022000000, y: 132.432, name: 'WE 2022-12-03/04' },
        { x: 1670108400000, y: 132.432, name: 'WE 2022-12-03/04' },
        { x: 1670194800000, y: 133.423, name: 'DA 2022-12-05' },
        { x: 1670281200000, y: 135.082, name: 'DA 2022-12-06' },
        { x: 1670367600000, y: 139.678, name: 'DA 2022-12-07' },
        { x: 1670454000000, y: 148.715, name: 'DA 2022-12-08' },
        { x: 1670540400000, y: 137.034, name: 'DA 2022-12-09' },
        { x: 1670626800000, y: 141.882, name: 'WE 2022-12-10/11' },
        { x: 1670713200000, y: 141.882, name: 'WE 2022-12-10/11' },
        { x: 1670799600000, y: 143.215, name: 'DA 2022-12-12' },
        { x: 1670886000000, y: 137.637, name: 'DA 2022-12-13' },
        { x: 1670972400000, y: 138.043, name: 'DA 2022-12-14' }
      ]
    }
  ],
  unit: '€/MWh'
}
*/
