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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const { Driver } = require('homey');
const crypto = require('crypto');
const ENTSOE = require('../../entsoe');

class MyDriver extends Driver {

	async onInit() {
		const dap = new ENTSOE();
		this.biddingZones = dap.getBiddingZones();
		this.log('onDriverInit');
	}

	async onPairListDevices() {
		const randomId = crypto.randomBytes(3).toString('hex');
		const devices = [];
		Object.entries(this.biddingZones).forEach((entry) => {
			const [description, biddingZone] = entry;
			devices.push({
				name: `${description}`,
				data: {
					id: `${biddingZone}_${randomId}`,
				},
				capabilities: [
					'meter_price_this_day_avg',
					'meter_price_next_8h_avg',
					'meter_price_h0',
					'meter_price_h1',
					'meter_price_h2',
					'meter_price_h3',
					'meter_price_h4',
					'meter_price_h5',
					'meter_price_h6',
					'meter_price_h7',
				],
				settings: {
					biddingZone,
					description,
					variableMarkup: 0,
					fixedMarkup: 0,
					exchangeRate: 1,
					sendTariff: false,
				},
			});
		});
		return devices;
	}

}

module.exports = MyDriver;
