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

const GenericDevice = require('../generic_device');

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

class sumDriver extends GenericDevice {

	onInit() {
		this.ds = deviceSpecifics;
		this.onInitDevice();
	}

	// driver specific stuff below

	async addListeners() {
		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false, $timeout: 20000 });

		if (!this.getSettings().use_measure_source) {
			// make listener for meter_power
			if (this.sourceDevice.capabilities.includes('meter_power')) {
				this.log(`registering meter_power capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.meterPower = await this.sourceDevice.makeCapabilityInstance('meter_power', (value) => {
					this.updateMeter(value);
				});

			}	else if (this.sourceDevice.capabilities.includes('meter_power.peak')
				&& this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
				this.log(`registering meter_power.peak/offPeak capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.meterPowerPeak = await this.sourceDevice.makeCapabilityInstance('meter_power.peak', (value) => {
					this.updateMeterPeak(value);
				});
				this.capabilityInstances.meterPowerOffPeak = await this.sourceDevice.makeCapabilityInstance('meter_power.offPeak', (value) => {
					this.updateMeterOffPeak(value);
				});
				this.lastPeak = this.sourceDevice.capabilitiesObj.meter_power.peak.value;
				this.lastOffPeak = this.sourceDevice.capabilitiesObj.meter_power.oofPeak.value;

			}	else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
				&& this.sourceDevice.capabilities.includes('meter_power.generated')) {
				this.log(`registering meter_power.consumed/generated capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.meterPowerConsumed = await this.sourceDevice.makeCapabilityInstance('meter_power.consumed', (value) => {
					this.updateMeterConsumed(value);
				});
				this.capabilityInstances.meterPowerGenerated = await this.sourceDevice.makeCapabilityInstance('meter_power.generated', (value) => {
					this.updateMeterGenerated(value);
				});
				this.lastConsumed = this.sourceDevice.capabilitiesObj.meter_power.consumed.value;
				this.lastGenerated = this.sourceDevice.capabilitiesObj.meter_power.generated.value;

			}	else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
				&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
				this.log(`registering meter_power.consumed/returned capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.meterPowerConsumed = await this.sourceDevice.makeCapabilityInstance('meter_power.consumed', (value) => {
					this.updateMeterConsumed(value);
				});
				this.capabilityInstances.meterPowerReturned = await this.sourceDevice.makeCapabilityInstance('meter_power.returned', (value) => {
					this.updateMeterReturned(value);
				});
				this.lastConsumed = this.sourceDevice.capabilitiesObj.meter_power.consumed.value;
				this.lastReturned = this.sourceDevice.capabilitiesObj.meter_power.returned.value;

			}	else if (this.sourceDevice.capabilities.includes('meter_power.delivered')
				&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
				this.log(`registering meter_power.consumed/returned capability listener for ${this.sourceDevice.name}`);
				this.capabilityInstances.meterPowerDelivered = await this.sourceDevice.makeCapabilityInstance('meter_power.delivered', (value) => {
					this.updateMeterDelivered(value);
				});
				this.capabilityInstances.meterPowerReturned = await this.sourceDevice.makeCapabilityInstance('meter_power.returned', (value) => {
					this.updateMeterReturned(value);
				});
				this.lastDelivered = this.sourceDevice.capabilitiesObj.meter_power.delivered.value;
				this.lastReturned = this.sourceDevice.capabilitiesObj.meter_power.returned.value;
			}
		} else if (this.sourceDevice.capabilities.includes('measure_power')) {
			this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
			this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance('measure_power', (value) => {
				this.updateMeterFromMeasure(value);
			});
		}
	}

	updateMeterConsumed(value) {
		this.lastConsumed = value;
		if (this.lastGenerated !== undefined) this.updateMeter(this.lastConsumed - this.lastGenerated);
		if (this.lastReturned !== undefined) this.updateMeter(this.lastConsumed - this.lastReturned);
	}

	updateMeterDelivered(value) {
		this.lastReturned = value;
		if (this.lastReturned !== undefined) this.updateMeter(this.lastConsumed - this.lastReturned);
	}

	updateMeterGenerated(value) {
		this.lastGenerated = value;
		if (this.lastConsumed !== undefined) this.updateMeter(this.lastConsumed - this.lastGenerated);
	}

	updateMeterReturned(value) {
		this.lastReturned = value;
		if (this.lastConsumed !== undefined) this.updateMeter(this.lastConsumed - this.lastReturned);
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
		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false, $timeout: 20000 });
		if (this.sourceDevice.capabilities.includes('meter_power')) {
			const pollValue = this.sourceDevice.capabilitiesObj.meter_power.value;
			const pollTm = new Date(this.sourceDevice.capabilitiesObj.meter_power.lastUpdated);
			this.updateMeter(pollValue, pollTm);

		} else if (this.sourceDevice.capabilities.includes('meter_power.peak') && this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
			const pollValuePeak = this.sourceDevice.capabilitiesObj['meter_power.peak'].value;
			const pollValueOffPeak = this.sourceDevice.capabilitiesObj['meter_power.offPeak'].value;
			const pollValue = pollValuePeak + pollValueOffPeak;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.peak.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.offPeak.lastUpdated);
			const pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;
			this.updateMeter(pollValue, pollTm);

		} else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
		&& this.sourceDevice.capabilities.includes('meter_power.generated')) {
			const pollValueConsumed = this.sourceDevice.capabilitiesObj['meter_power.consumed'].value;
			const pollValueGenerated = this.sourceDevice.capabilitiesObj['meter_power.generated'].value;
			const pollValue = pollValueConsumed - pollValueGenerated;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.consumed.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.generated.lastUpdated);
			const pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;
			this.updateMeter(pollValue, pollTm);

		}	else if (this.sourceDevice.capabilities.includes('meter_power.consumed')
		&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
			const pollValueConsumed = this.sourceDevice.capabilitiesObj['meter_power.consumed'].value;
			const pollValueReturned = this.sourceDevice.capabilitiesObj['meter_power.returned'].value;
			const pollValue = pollValueConsumed - pollValueReturned;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.consumed.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.returned.lastUpdated);
			const pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;
			this.updateMeter(pollValue, pollTm);

		}	else if (this.sourceDevice.capabilities.includes('meter_power.delivered')
		&& this.sourceDevice.capabilities.includes('meter_power.returned')) {
			const pollValueDelivered = this.sourceDevice.capabilitiesObj['meter_power.delivered'].value;
			const pollValueReturned = this.sourceDevice.capabilitiesObj['meter_power.returned'].value;
			const pollValue = pollValueDelivered - pollValueReturned;

			const pollTm1 = new Date(this.sourceDevice.capabilitiesObj.meter_power.delivered.lastUpdated);
			const pollTm2 = new Date(this.sourceDevice.capabilitiesObj.meter_power.returned.lastUpdated);
			const pollTm = pollTm1 > pollTm2 ? pollTm1 : pollTm2;
			this.updateMeter(pollValue, pollTm);
		}
	}

}

module.exports = sumDriver;

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
