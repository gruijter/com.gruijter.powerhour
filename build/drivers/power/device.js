/*
Copyright 2019 - 2021, Robin de Gruijter (gruijter@hotmail.com)

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
		this_hour_total: 'meter_kwh_this_hour',
		last_hour_total: 'meter_kwh_last_hour',
		this_day_total: 'meter_kwh_this_day',
		last_day_total:	'meter_kwh_last_day',
		this_month_total: 'meter_kwh_this_month',
		last_month_total: 'meter_kwh_last_month',
		this_year_total: 'meter_kwh_this_year',
		last_year_total: 'meter_kwh_last_year',
	},

};

class sumDriver extends GenericDevice {

	onInit() {
		this.ds = deviceSpecifics;
		this.onInitDevice();
	}

	// driver specific stuff below

	async addListeners() {
		// make listener for meter_power
		if (this.sourceDevice.capabilities.includes('meter_power')) {
			this.log(`registering meter_power capability listener for ${this.sourceDevice.name}`);
			this.capabilityInstances.meterPower = this.sourceDevice.makeCapabilityInstance('meter_power', (value) => {
				this.updateMeter(value);
			});
		}	else if (this.sourceDevice.capabilities.includes('meter_power.peak') && this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
			this.log(`registering meter_power.peak/offPeak capability listener for ${this.sourceDevice.name}`);
			this.capabilityInstances.meterPowerPeak = this.sourceDevice.makeCapabilityInstance('meter_power.peak', (value) => {
				this.updateMeterPeak(value);
			});
			this.capabilityInstances.peterPowerOffPeak = this.sourceDevice.makeCapabilityInstance('meter_power.offPeak', (value) => {
				this.updateMeterOffPeak(value);
			});
		}
	}

	updateMeterPeak(value) {
		this.lastPeak = value;
		if (this.lastOffPeak !== undefined) this.updateMeter(this.lastPeak + this.lastOffPeak);
	}

	updateMeterOffPeak(value) {
		this.lastOffPeak = value;
		if (this.lastPeak !== undefined) this.updateMeter(this.lastPeak + this.lastOffPeak);
	}

	async pollMeter() {
		if (this.sourceDevice.capabilities.includes('meter_power')) {
			const pollValue = this.sourceDevice.capabilitiesObj.meter_power.value;
			this.updateMeter(pollValue);
		} else if (this.sourceDevice.capabilities.includes('meter_power.peak') && this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
			const pollValuePeak = this.sourceDevice.capabilitiesObj['meter_power.peak'].value;
			const pollValueOffPeak = this.sourceDevice.capabilitiesObj['meter_power.offPeak'].value;
			this.updateMeterPeak(pollValuePeak + pollValueOffPeak);
		}
	}

}

module.exports = sumDriver;
