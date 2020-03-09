/*
Copyright 2019 - 2020, Robin de Gruijter (gruijter@hotmail.com)

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

const GenericDevice = require('../generic_device.js');

const deviceSpecifics = {
	cmap: {
		this_hour_total: 'm3_this_hour_total',
		last_hour_total: 'm3_last_hour_total',
		this_day_total: 'm3_this_day_total',
		last_day_total:	'm3_last_day_total',
		this_month_total: 'm3_this_month_total',
		last_month_total: 'm3_last_month_total',
		this_year_total: 'm3_this_year_total',
		last_year_total: 'm3_last_year_total',
	},
};

class sumDriver extends GenericDevice {

	onInit() {
		this.ds = deviceSpecifics;
		this.onInitDevice();
	}

	// driver specific stuff below

	async addListeners() {
		// make listener for meter_gas
		this.log(`registering meter_gas capability listener for ${this.sourceDevice.name}`);
		if (this.sourceDevice.capabilities.includes('meter_water')) {
			this.capabilityInstances.meterWater = this.sourceDevice.makeCapabilityInstance('meter_water', (value) => {
				this.updateMeter(value);
			});
		}
	}

	pollMeter() {
		const pollValue = this.sourceDevice.capabilitiesObj.meter_water.value;
		this.updateMeter(pollValue);
	}

}

module.exports = sumDriver;
