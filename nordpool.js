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

const defaultHost = 'www.nordpoolgroup.com';
const defaultPort = 443;
const defaultTimeout = 30000;

// mapping for nordpool page, market name, timezone (defaults to CET/CEST)
const biddingZonesMap = {
	// AL_Albania: '10YAL-KESH-----5',
	'10YAT-APG------L': [298578, 'AT'], // AT_Austria
	'10YBE----------2': [298736, 'BE'], // BE_Belgium
	// BG_Bulgaria: '10YCA-BULGARIA-R',
	// CH_Switzerland: '10YCH-SWISSGRIDZ',
	// CR_Croatia: '10YHR-HEP------M',
	// CZ_Czech_Republic_PL_CZ: '10YDOM-1001A082L',
	// DE_Germany: '10Y1001A1001A83F',
	'10Y1001A1001A82H': [299565, 'DE-LU'], // DE_Germany_DE_LU
	// DK_Denmark: '10Y1001A1001A65H',
	'10YDK-1--------W': [41, 'DK1'], // DK_Denmark_1
	'10YDK-2--------M': [41, 'DK2'], // DK_Denmark_2
	// DK_Denmark_Energinet: '10Y1001A1001A796',
	'10Y1001A1001A39I': [47, 'EE'], // EE_Estonia
	// ES_Spain: '10YES-REE------0',
	'10YFI-1--------U': [35, 'FI'], // FI_Finland
	'10YFR-RTE------C': [299568, 'FR'], // FR_France
	'10Y1001A1001A92E': [325, 'GB', 'BST'], // GB_United_Kingdom:
	// GB_United_Kingdom_National_Grid: '10YGB----------A',
	// GB_United_Kingdom_NIE_SONI: '10Y1001A1001A016',
	// GR_Greece: '10YGR-HTSO-----Y',
	// HU_Hungary: '10YHU-MAVIR----U',
	// IE_Ireland_EirGrid: '10YIE-1001A00010',
	// IS_Iceland: 'IS',
	// IT_Italy: '10YIT-GRTN-----B',
	// IT_Italy_Calabria: '10Y1001C--00096J',
	// IT_Italy_Center_South: '10Y1001A1001A71M',
	// IT_Italy_Centre_North: '10Y1001A1001A70O',
	// IT_Italy_Macrozone_North: '10Y1001A1001A84D',
	// IT_Italy_Macrozone_South: '10Y1001A1001A85B',
	// IT_Italy_North: '10Y1001A1001A73I',
	// IT_Italy_Saco_AC: '10Y1001A1001A885',
	// IT_Italy_Saco_DC: '10Y1001A1001A893',
	// IT_Italy_Sardinia: '10Y1001A1001A74G',
	// IT_Italy_Sicily: '10Y1001A1001A75E',
	// IT_Italy_South: '10Y1001A1001A788',
	'10YLT-1001A0008Q': [53, 'LT'], // LT_Lithuania
	// LU_Luxemburg_CREOS: '10YLU-CEGEDEL-NQ',
	// LU_Luxemburg_DE_LU: '10Y1001A1001A82H',
	'10YLV-1001A00074': [59, 'LV'], // LV_Latvia
	// MK_North_Macedonia: '10YMK-MEPSO----8',
	'10YNL----------L': [299571, 'NL'], // NL_Netherlands
	'10YNO-1--------2': [23, 'Oslo'], // NO_Norway_1
	'10YNO-2--------T': [23, 'Kr.sand'], // NO_Norway_2
	// '50Y0JVU59B4JWQCU': [429416, 'NO2', 'BST'], // NO_Norway_2NSL > ONLY PROVIDES SINGLE DAY DATA
	'10YNO-3--------J': [23, 'Molde'], // NO_Norway_3
	'10YNO-4--------9': [23, 'Troms%C3%B8'], // NO_Norway_4
	'10Y1001A1001A48H': [23, 'Bergen'], // NO_Norway_5
	// NO_Norway_Stattnet: '10YNO-0--------C',
	// PL_Poland_PL_CZ: '10YDOM-1001A082L',
	'10YPL-AREA-----S': [391921, 'PL'], // PL_Poland_PSE
	// PT_Portugal: '10YPT-REN------W',
	// RO_Romania: '10YRO-TEL------P',
	// RS_Serbia: '10YCS-SERBIATSOV',
	// RU_Russia: 'RU',
	// RU_Russia_EMS: '10Y1001A1001A49F',
	// RU_Russia_Kaliningrad: '10Y1001A1001A50U',
	'10Y1001A1001A44P': [29, 'SE1'], // SE_Sweden_1
	'10Y1001A1001A45N': [29, 'SE2'], // SE_Sweden_2
	'10Y1001A1001A46L': [29, 'SE3'], // SE_Sweden_3
	'10Y1001A1001A47J': [29, 'SE4'], // SE_Sweden_4
	// '10YSE-1--------K': [29, 'SE'], // SE_Sweden_SvK
	// SI_Slovenia: '10YSI-ELES-----O',
	// SK_Slovakia_SEPS: '10YSK-SEPS-----K',
	// TR_Turkey_TEIAS: '10YTR-TEIAS----W',
	// UA_Ukaine_BEI: '10YUA-WEPS-----0',
	// UA_Ukaine_DobTPP: '10Y1001A1001A869',
	// UA_Ukaine_IPS: '10Y1001C--000182',
	// UA_Ukraine: '10Y1001C--00003F',
	// ZZ_CWE_Region: '10YDOM-REGION-1V',
};

class Nordpool {
	// Represents a session to the Nordpool API.
	constructor(opts) {
		const options = opts || {};
		this.host = options.host || defaultHost;
		this.port = options.port || defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.apiKey = options.apiKey;
		this.biddingZone = options.biddingZone;
		this.zoneSupported = !!biddingZonesMap[this.biddingZone];
		this.lastResponse = undefined;
	}

	async getPrices(options) {
		try {
			const today = new Date();
			const tomorrow = new Date(today);
			tomorrow.setDate(today.getDate() + 1);

			const opts = options || {};
			const zone = opts.biddingZone || this.biddingZone;
			const start = opts.dateStart ? new Date(opts.dateStart) : today;
			const end = opts.dateEnd ? new Date(opts.dateEnd) : tomorrow;
			// start.setHours(0);
			start.setMinutes(0);
			start.setSeconds(0);
			start.setMilliseconds(0);
			// console.log(start, end);

			if (!zone || !biddingZonesMap[zone]) throw Error('biddingZone not supported by Nordpool');
			this.zoneSupported = true;
			// convert from UTC to BTC or CET/CEST for API request
			const timeZone = 'Europe/Amsterdam'; // biddingZonesMap[zone][2] === 'BST' ? 'Europe/London' : 'Europe/Amsterdam';

			// construct API path
			const page = biddingZonesMap[zone][0];
			const entityName = biddingZonesMap[zone][1];
			let endDate = new Date(end.toLocaleString('en-US', { timeZone }));
			endDate = endDate.toLocaleDateString('en-GB').replace(/\//g, '-');
			const path = `/api/marketdata/page/${page}?currency=,EUR,EUR,EUR&endDate=${endDate}&entityName=${entityName}`;

			// console.log(start, endDate, path);
			const res = await this._makeRequest(path);
			if (!res.data || !res.data.Rows) throw Error('no price data found');

			// flatten data
			let flat = [];
			res.data.Rows
				.filter((row) => row.Name.includes('&nbsp;-&nbsp;'))	// select hours 0 - 23
				.forEach((row, index) => row.Columns
					.filter((column) => !column.Value.includes('&nbsp;-&nbsp')) // remove timezone info
					.forEach((column) => {
						const dateParts = column.Name.split('-');
						let date = new Date(+dateParts[2], dateParts[1] - 1, +dateParts[0]);
						const timeZoneOffset = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })) - date;
						date.setMilliseconds(-timeZoneOffset); // convert date BST or CET/CEST to UTC
						date = new Date(date.getTime() + index * 60 * 60 * 1000); // add hours
						flat.push({ date, value: Number(column.Value.replace(',', '.')) });
					}));
			flat = flat.sort((a, b) => a.date - b.date);

			// loop through all days
			const info = [];
			const day = start;
			while (day <= end) {
				const dayStart = new Date(day); // assuming exact start of a local day in UTC notation
				const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000); // add 24 hours
				const itemsDay = flat.filter((item) => item.date >= dayStart && item.date < dayEnd);
				const prices = itemsDay.map((item) => item.value);
				if (prices.length > 0) {
					const timeInterval = {
						start: itemsDay[0].date,
						end: itemsDay[itemsDay.length - 1].date,
					};
					info.push({ timeInterval, prices });
				}
				day.setDate(day.getDate() + 1);
			}
			return Promise.resolve(info);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(actionPath, timeout) {
		try {
			const postMessage = '';
			const headers = {};
			const options = {
				hostname: this.host,
				port: this.port,
				path: actionPath,
				headers,
				method: 'GET',
			};
			const result = await this._makeHttpsRequest(options, postMessage, timeout);
			this.lastResponse = result.body || result.statusCode;
			const contentType = result.headers['content-type'];
			if (!/application\/json/.test(contentType)) {
				throw Error(`Expected json but received ${contentType}: ${result.body}`);
			}
			// find errors
			if (result.statusCode !== 200) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
			}
			const json = JSON.parse(result.body);
			// console.dir(json, { depth: null });
			return Promise.resolve(json);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	_makeHttpsRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
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

module.exports = Nordpool;

// // START TEST HERE
// const NP = new Nordpool({ biddingZone: '10Y1001A1001A92E' }); // '10YNL----------L'

// NP.getPrices()
// 	.then((result) => console.dir(result, { depth: null }))
// 	.catch((error) => console.log(error));

/*
All area's: https://www.nordpoolgroup.com/api/marketdata/page/10?currency=,EUR,EUR,EUR&endDate=10-09-2022
NL area: https://www.nordpoolgroup.com/api/marketdata/page/299571?currency=,EUR,EUR,EUR&endDate=10-09-2022

Oslo area: https://www.nordpoolgroup.com/api/marketdata/page/23?currency=,EUR,EUR,EUR&entityName=Oslo
SE1/SE2/SE3/SE4/SE: https://www.nordpoolgroup.com/api/marketdata/page/29?currency=,EUR,EUR,EUR&entityName=SE1

area: 'NL', // See http://www.nordpoolspot.com/maps/
{
	"AT": 298578
	"BE": 298736
	"DE", 299565
	DK: 41 "DK1", "DK2",
	EE: 47 "EE", "ELE",
	FI: 35
	"FR": 299568
	"FRE",
  GB: 325 (BST)
	"GER"
	"KT",
	"LT": 53
	"LV": 59
	NL: 299571
	"NO2": 429416 (BST)
	NO: 23 // "Oslo", "Kr.sand", "Molde" / "Tr.heim", "Tromsø", "Bergen",
	SE: 29 "SE1", "SE2", "SE3", "SE4", "SE"
	PL: 391921

NO1 - Oslo,
NO2 - Kristiansand
NO3 - Molde, Trondheim
NO4 - Tromsø
NO5 - Bergen

 SE1 - Luleå; SE2 - Sundsvall; SE3 - Stockholm; SE4 - Malmö

]

currency: 'EUR'
[ "EUR", "DKK", "NOK", "SEK" ]

Unit
[ "EUR/MWh", "DKK/MWh", "NOK/MWh", "SEK/MWh" ]

*/
