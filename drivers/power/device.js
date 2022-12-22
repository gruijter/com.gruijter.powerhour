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

const GenericDevice = require('../generic_sum_device');

const deviceSpecifics = {
	cmap: {
		this_hour: 'meter_kwh_this_hour',
		last_hour: 'meter_kwh_last_hour',
		this_day: 'meter_kwh_this_day',
		last_day:	'meter_kwh_last_day',
		this_month: 'meter_kwh_this_month',
		last_month: 'meter_kwh_last_month',
		this_year: 'meter_kwh_this_year',
		last_year: 'meter_kwh_last_year',
		meter_source: 'meter_power',
		measure_source: 'measure_watt_avg',
	},

};

// p1 consumption counter (low/all tariff).
// p2 consumption counter (high tariff).
// n1 returned counter (low/all tariff).
// n2 returned counter (high tariff).
// total energy counter = p1+p2-n1-n2

const sourceCapGroups = [
	{
		p1: 'meter_power', p2: null, n1: null, n2: null,	// youless
	},
	{
		p1: 'meter_power.peak', p2: 'meter_power.offPeak', n1: null, n2: null,
	},
	{
		p1: 'meter_power.consumed', p2: null, n1: 'meter_power.generated', n2: null,
	},
	{
		p1: 'meter_power.consumed', p2: null, n1: 'meter_power.returned', n2: null,
	},
	{
		p1: 'meter_power.delivered', p2: null, n1: 'meter_power.returned', n2: null,
	},
	{
		p1: 'meter_power.import', p2: null, n1: 'meter_power.export', n2: null,	// qubino
	},
];

class sumDevice extends GenericDevice {

	onInit() {
		this.ds = deviceSpecifics;
		this.onInitDevice();
	}

	// device specific stuff below
	async addListeners() {
		this.lastGroupMeter = {}; // last values of capability meters
		this.lastGroupMeterReady = false;
		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false, $timeout: 20000 });

		// start listener for METER_VIA_WATT device
		if (this.getSettings().use_measure_source) {
			if (this.sourceDevice.capabilities.includes('measure_power')) {
				this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance('measure_power', (value) => {
					this.updateMeterFromMeasure(value).catch(this.error);
				});
				return;
			}
			throw Error(`${this.sourceDevice.name} has no measure_power capability`);
		}

		// check if HOMEY-API source device fits to a defined capability group
		this.sourceCapGroup = null; // relevant capabilities found in the source device
		sourceCapGroups.forEach((capGroup) => {
			if (this.sourceCapGroup) return; // stop at the first match
			const requiredKeys = Object.values(capGroup).filter((v) => v);
			const hasAllKeys = requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
			if (hasAllKeys) this.sourceCapGroup = capGroup;
		});
		if (!this.sourceCapGroup) throw Error(`${this.sourceDevice.name} has no compatible meter_power capabilities`);

		// start listeners for HOMEY-API device
		Object.keys(this.sourceCapGroup).forEach((key) => {
			if (this.sourceCapGroup[key]) {
				this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], (value) => {
					this.lastGroupMeter[key] = value;
					this.updateGroupMeter(value, key).catch(this.error);
				});
			}
		});
		// get the init values for this.lastGroupMeter
		Object.keys(this.sourceCapGroup)
			.filter((k) => this.sourceCapGroup[k])
			.forEach((k) => {
				this.lastGroupMeter[k] = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[k]].value;
			});
		this.lastGroupMeterReady = true;
	}

	async updateGroupMeter() {
		// check if all GroupCaps have received their first value.
		if (!this.lastGroupMeterReady) {
			this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
			return;
		}

		// calculate the sum, and update meter
		let total = 0;
		total = Number.isFinite(this.lastGroupMeter.p1) ? total += this.lastGroupMeter.p1 : total;
		total = Number.isFinite(this.lastGroupMeter.p2) ? total += this.lastGroupMeter.p2 : total;
		total = Number.isFinite(this.lastGroupMeter.n1) ? total -= this.lastGroupMeter.n1 : total;
		total = Number.isFinite(this.lastGroupMeter.n2) ? total -= this.lastGroupMeter.n2 : total;
		this.updateMeter(total).catch(this.error);
	}

	// Setup how to poll the meter
	async pollMeter() {

		// poll a Homey Energy device
		if (this.getSettings().homey_energy) {
			const report = await this.homey.app.api.energy.getLiveReport();
			// console.dir(report, { depth: null, colors: true });
			const value = report[this.settings.homey_energy].W;
			this.updateMeterFromMeasure(value).catch(this.error);
			return;
		}

		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false, $timeout: 20000 });
		let pollValue = null;
		let pollTm = null;

		if (this.sourceDevice.capabilities.includes('meter_power')) {
			pollValue = this.sourceDevice.capabilitiesObj.meter_power.value;
			pollTm = new Date(this.sourceDevice.capabilitiesObj.meter_power.lastUpdated);

		} else if (this.sourceDevice.capabilities.includes('meter_power.peak') && this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
			const pollValuePeak = this.sourceDevice.capabilitiesObj['meter_power.peak'].value;
			const pollValueOffPeak = this.sourceDevice.capabilitiesObj['meter_power.offPeak'].value;
			pollValue = pollValuePeak + pollValueOffPeak;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.peak.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.offPeak.lastUpdated);
			pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;

		} else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
		&& this.sourceDevice.capabilities.includes('meter_power.generated')) {
			const pollValueConsumed = this.sourceDevice.capabilitiesObj['meter_power.consumed'].value;
			const pollValueGenerated = this.sourceDevice.capabilitiesObj['meter_power.generated'].value;
			pollValue = pollValueConsumed - pollValueGenerated;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.consumed.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.generated.lastUpdated);
			pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;

		}	else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
		&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
			const pollValueConsumed = this.sourceDevice.capabilitiesObj['meter_power.consumed'].value;
			const pollValueReturned = this.sourceDevice.capabilitiesObj['meter_power.returned'].value;
			pollValue = pollValueConsumed - pollValueReturned;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.consumed.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.returned.lastUpdated);
			pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;

		}	else if (this.sourceDevice.capabilities.includes('meter_power.delivered')
		&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
			const pollValueDelivered = this.sourceDevice.capabilitiesObj['meter_power.delivered'].value;
			const pollValueReturned = this.sourceDevice.capabilitiesObj['meter_power.returned'].value;
			pollValue = pollValueDelivered - pollValueReturned;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.delivered.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.returned.lastUpdated);
			pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;
		}

		await this.updateMeter(pollValue, pollTm);
	}

}

module.exports = sumDevice;

/*
capabilitiesObj:
{
  measure_power: {
    value: 430,
    lastUpdated: '2022-01-27T15:59:52.519Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power',
    desc: 'Power in watt (W)',
    units: 'W',
    decimals: 2,
    chartType: 'stepLine',
    id: 'measure_power',
    options: {}
  },
  meter_power: {
    value: 33744.268,
    lastUpdated: '2022-01-27T15:59:52.519Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter total',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power',
    options: { title: [Object], decimals: 4 }
  },
  meter_offPeak: {
    value: false,
    lastUpdated: '2022-01-27T06:00:35.274Z',
    type: 'boolean',
    getable: true,
    setable: false,
    title: 'Off peak',
    desc: 'Is off-peak tarriff active?',
    units: null,
    iconObj: {
      id: 'b4084ca4a885c7f194378c9792b56d1e',
      url: '/icon/b4084ca4a885c7f194378c9792b56d1e/icon.svg'
    },
    id: 'meter_offPeak',
    options: {}
  },
  'meter_power.peak': {
    value: 15856.372,
    lastUpdated: '2022-01-27T15:59:52.520Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.peak',
    options: { title: [Object], decimals: 4 }
  },
  'meter_power.offPeak': {
    value: 26309.979,
    lastUpdated: '2022-01-27T06:00:15.250Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter off-peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.offPeak',
    options: { meter_power: [Object], title: [Object], decimals: 4 }
  },
  'meter_power.producedPeak': {
    value: 6128.784,
    lastUpdated: '2022-01-21T12:04:45.551Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Production peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.producedPeak',
    options: { title: [Object], decimals: 4 }
  },
  'meter_power.producedOffPeak': {
    value: 2293.299,
    lastUpdated: '2022-01-09T14:42:54.559Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Production off-peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.producedOffPeak',
    options: { title: [Object], decimals: 4 }
  },
  measure_gas: {
    value: 0.463,
    lastUpdated: '2022-01-27T15:03:50.934Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Gas',
    desc: 'Gas usage',
    units: 'm³ /hr',
    decimals: 4,
    iconObj: {
      id: '802e0ad3d838346f6bc6e5e3d580e53d',
      url: '/icon/802e0ad3d838346f6bc6e5e3d580e53d/icon.svg'
    },
    id: 'measure_gas',
    options: {}
  },
  meter_gas: {
    value: 9308.75,
    lastUpdated: '2022-01-27T15:03:50.935Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Gas meter',
    desc: 'Gas usage in cubic meter (m³)',
    units: 'm³',
    decimals: 2,
    min: 0,
    chartType: 'spline',
    id: 'meter_gas',
    options: {}
  }
}

*/
