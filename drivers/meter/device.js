/* eslint-disable camelcase */
/* eslint-disable import/no-extraneous-dependencies */
/*
Copyright 2019, Robin de Gruijter (gruijter@hotmail.com)

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

const Homey = require('homey');

class Meter extends Homey.Device {

	// this method is called when the Device is inited
	async onInit() {
		// this.log('device init: ', this.getName(), 'id:', this.getData().id);
		try {
			// init some stuff
			this._driver = await this.getDriver();
			this.settings = await this.getSettings();
			this.sourceDevice = await this.getSourceDevice();
			this.destroyListeners();
			// start listening to device and update info
			this.addListeners();
		} catch (error) {
			this.error(error);
		}
	}

	restartDevice(delay) {
		this.destroyListeners();
		setTimeout(() => {
			this.onInit();
		}, delay || 10000);
	}

	// this method is called when the Device is added
	async onAdded() {
		this.log(`Meter added as device: ${this.getName()}`);
	}

	// this method is called when the Device is deleted
	onDeleted() {
		this.destroyListeners();
		this.log(`Meter deleted as device: ${this.getName()}`);
	}

	onRenamed(name) {
		this.log(`Meter renamed to: ${name}`);
	}

	// this method is called when the user has changed the device's settings in Homey.
	onSettings() { // oldSettingsObj, newSettingsObj, changedKeysArr) {
		this.log('settings change requested by user');
		// this.log(newSettingsObj);
		this.log(`${this.getName()} device settings changed`);
		// do callback to confirm settings change
		Promise.resolve(true);
		return this.restartDevice(1000);
	}

	async getSourceDevice() {
		this.api = await this._driver.api;
		this.sourceDevice = await this.api.devices.getDevice({ id: this.getSettings().homey_device_id });
		return Promise.resolve(this.sourceDevice);
	}

	async destroyListeners() {
		this.log('Destroying listeners');
		if (this.capabilityInstances) {
			Object.entries(this.capabilityInstances).forEach((entry) => {
				// console.log(`destroying listener ${entry[0]}`);
				entry[1].destroy();
			});
		}
		this.capabilityInstances = {};
	}

	async addListeners() {
		// make listener for meter_power
		this.log(`registering meter_power capability listener for ${this.sourceDevice.name}`);
		if (this.sourceDevice.capabilities.includes('meter_power')) {
			this.capabilityInstances.meterPower = this.sourceDevice.makeCapabilityInstance('meter_power', (value) => {
				this.updateMeterPower(value);
			});
		}	else if (this.sourceDevice.capabilities.includes('meter_power.peak') && this.sourceDevice.capabilities.includes('meter_power.offPeak')) {
			this.capabilityInstances.meterPowerPeak = this.sourceDevice.makeCapabilityInstance('meter_power.peak', (value) => {
				this.updateMeterPowerPeak(value);
			});
			this.capabilityInstances.peterPowerOffPeak = this.sourceDevice.makeCapabilityInstance('meter_power.offPeak', (value) => {
				this.updateMeterPowerOffPeak(value);
			});
		}
	}

	updateMeterPowerCron() {
		if (this.lastReading)	this.updateMeterPower(this.lastReading.meterPowerValue);
		// console.log(this.getName(), this.lastReading);
	}

	updateMeterPowerPeak(value) {
		this.lastPowerPeak = value;
		if (this.lastPowerOffPeak !== undefined) this.updateMeterPower(this.lastPowerPeak + this.lastPowerOffPeak);
	}

	updateMeterPowerOffPeak(value) {
		this.lastPowerOffPeak = value;
		if (this.lastPowerPeak !== undefined) this.updateMeterPower(this.lastPowerPeak + this.lastPowerOffPeak);
	}

	async updateMeterPower(value) {
		try {
			const ts = new Date();
			const reading = {
				hour: ts.getHours(),
				day: ts.getDate(),
				month: ts.getMonth(),
				meterPowerValue: value,
			};
			this.lastReading = reading;
			this.updateHour(reading);
			this.updateDay(reading);
			this.updateMonth(reading);
		} catch (error) {
			this.error(error);
		}
	}

	updateHour(reading) {
		if (!this.lastReadingHour) {	// after init
			this.lastReadingHour = this.getStoreValue('lastReadingHour');
			if (!this.lastReadingHour) {	// after new pair
				this.setStoreValue('lastReadingHour', reading);
				this.lastReadingHour = reading;
			}
		}
		const val = reading.meterPowerValue - this.lastReadingHour.meterPowerValue;
		if ((reading.day === this.lastReadingHour.day) && (reading.hour === this.lastReadingHour.hour)) {
			this.setCapabilityValue('power_hour', val);
		} else {
			// new hour started
			this.setCapabilityValue('power_hour', 0);
			this.setCapabilityValue('power_hour_total', val);
			this.setStoreValue('lastReadingHour', reading);
			this.lastReadingHour = reading;
		}
	}

	updateDay(reading) {
		if (!this.lastReadingDay) {	// after init
			this.lastReadingDay = this.getStoreValue('lastReadingDay');
			if (!this.lastReadingDay) {	// after new pair
				this.setStoreValue('lastReadingDay', reading);
				this.lastReadingDay = reading;
			}
		}
		const val = reading.meterPowerValue - this.lastReadingDay.meterPowerValue;
		if ((reading.month === this.lastReadingDay.month) && (reading.day === this.lastReadingDay.day)) {
			this.setCapabilityValue('power_day', val);
		} else {
			// new day started
			this.setCapabilityValue('power_day', 0);
			this.setCapabilityValue('power_day_total', val);
			this.setStoreValue('lastReadingDay', reading);
			this.lastReadingDay = reading;
		}
	}

	updateMonth(reading) {
		if (!this.lastReadingMonth) {	// after init
			this.lastReadingMonth = this.getStoreValue('lastReadingMonth');
			if (!this.lastReadingMonth) {	// after new pair
				this.setStoreValue('lastReadingMonth', reading);
				this.lastReadingMonth = reading;
			}
		}
		const val = reading.meterPowerValue - this.lastReadingMonth.meterPowerValue;
		if ((reading.month === this.lastReadingMonth.month)) {
			this.setCapabilityValue('power_month', val);
		} else {
			// new month started
			this.setCapabilityValue('power_month', 0);
			this.setCapabilityValue('power_month_total', val);
			this.setStoreValue('lastReadingMonth', reading);
			this.lastReadingMonth = reading;
		}
	}

}

module.exports = Meter;

/*
meter_power:
{ value: 24171.113,
	lastUpdated: 2019-11-10T16:05:06.820Z,
	type: 'number',
	getable: true,
	setable: false,
	title: 'Power meter total',
	desc: 'Power usage in KiloWattHour (kWh)',
	units: 'KWh',
	decimals: 4,
	chartType: 'spline',
	id: 'meter_power',
	options: [Object],
	values: undefined },
*/

/*
	{
	__athom_api_type: 'HomeyAPI.ManagerDevices.Device',
	id: 'ae8202ab-e207-419c-96b0-2723c5873add',
	name: 'LS120P1',
	driverUri: 'homey:app:com.gruijter.enelogic',
	driverId: 'LS120',
	zone: '9919ee1e-ffbc-480b-bc4b-77fb047e9e68',
	zoneName: 'Home',
	icon: null,
	iconObj:
	 { id: '4fa6d70ad49d38533f21701f1b993427',
		 url: '/icon/4fa6d70ad49d38533f21701f1b993427/icon.svg' },
	settings:
	 { youLessIp: '10.0.0.48',
		 password: '',
		 model: 'LS120',
		 mac: '72:b8:a:14:26:1b',
		 ledring_usage_limit: 2500,
		 ledring_production_limit: 1800,
		 pollingInterval: 10,
		 filterReadings: false,
		 energy_cumulative_include: true,
		 include_off_peak: true,
		 include_production: true,
		 include_gas: true },
	settingsObj: true,
	class: 'sensor',
	energy: null,
	energyObj: { W: 2360, batteries: null, cumulative: true, generator: null },
	virtualClass: null,
	capabilities:
	 [ 'measure_power',
		 'meter_power',
		 'meter_offPeak',
		 'meter_power.peak',
		 'meter_power.offPeak',
		 'meter_power.producedPeak',
		 'meter_power.producedOffPeak',
		 'measure_gas',
		 'meter_gas' ],
	capabilitiesObj:
	 { measure_power:
			{ value: 2350,
				lastUpdated: 2019-11-10T16:05:06.818Z,
				type: 'number',
				getable: true,
				setable: false,
				title: 'Power',
				desc: 'Power in Watt (W)',
				units: 'W',
				decimals: 2,
				chartType: 'stepLine',
				id: 'measure_power',
				options: {},
				values: undefined },
		 meter_power:
			{ value: 24171.113,
				lastUpdated: 2019-11-10T16:05:06.820Z,
				type: 'number',
				getable: true,
				setable: false,
				title: 'Power meter total',
				desc: 'Power usage in KiloWattHour (kWh)',
				units: 'KWh',
				decimals: 4,
				chartType: 'spline',
				id: 'meter_power',
				options: [Object],
				values: undefined },
		 meter_offPeak:
			{ value: true,
				lastUpdated: '2019-11-10T16:04:56.850Z',
				type: 'boolean',
				getable: true,
				setable: false,
				title: 'Off-peak',
				desc: 'Is off-peak tarriff active?',
				units: null,
				iconObj: [Object],
				id: 'meter_offPeak',
				options: {},
				values: undefined },
		 'meter_power.peak':
			{ value: 11682.777,
				lastUpdated: '2019-11-10T16:04:56.844Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Power meter peak',
				desc: 'Power usage in KiloWattHour (kWh)',
				units: 'KWh',
				decimals: 4,
				chartType: 'spline',
				id: 'meter_power.peak',
				options: [Object],
				values: undefined },
		 'meter_power.offPeak':
			{ value: 19190.603,
				lastUpdated: '2019-11-10T16:04:56.855Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Power meter off-peak',
				desc: 'Power usage in KiloWattHour (kWh)',
				units: 'KWh',
				decimals: 4,
				chartType: 'spline',
				id: 'meter_power.offPeak',
				options: [Object],
				values: undefined },
		 'meter_power.producedPeak':
			{ value: 4886.989,
				lastUpdated: '2019-11-10T16:04:56.864Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Production peak',
				desc: 'Power usage in KiloWattHour (kWh)',
				units: 'KWh',
				decimals: 4,
				chartType: 'spline',
				id: 'meter_power.producedPeak',
				options: [Object],
				values: undefined },
		 'meter_power.producedOffPeak':
			{ value: 1815.284,
				lastUpdated: '2019-11-10T16:04:56.869Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Production off-peak',
				desc: 'Power usage in KiloWattHour (kWh)',
				units: 'KWh',
				decimals: 4,
				chartType: 'spline',
				id: 'meter_power.producedOffPeak',
				options: [Object],
				values: undefined },
		 measure_gas:
			{ value: 0.091,
				lastUpdated: '2019-11-10T16:04:56.838Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Gas',
				desc: 'Gas usage',
				units: 'm³ /hr',
				decimals: 4,
				iconObj: [Object],
				id: 'measure_gas',
				options: {},
				values: undefined },
		 meter_gas:
			{ value: 7016.65,
				lastUpdated: '2019-11-10T16:04:56.841Z',
				type: 'number',
				getable: true,
				setable: false,
				title: 'Gas Meter',
				desc: 'Gas usage in Cubic Meter (m³)',
				units: 'm³',
				decimals: 2,
				min: 0,
				chartType: 'spline',
				id: 'meter_gas',
				options: {},
				values: undefined } },
	flags: [],
	ui: { components: [ [Object] ], componentsStartAt: 0 },
	ready: true,
	available: true,
	repair: false,
	unpair: false,
	unavailableMessage: null,
	speechExamples: [],
	images: [],
	insights:
	 [ { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'measure_power',
			 type: 'number',
			 title: 'Power',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'W' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_power',
			 type: 'number',
			 title: 'Power Meter',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'KWh' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_offPeak',
			 type: 'boolean',
			 title: 'Off-peak',
			 titleTrue: 'Off-peak',
			 titleFalse: 'Peak',
			 units: null,
			 decimals: null },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_power.peak',
			 type: 'number',
			 title: 'Power meter peak',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'KWh' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_power.offPeak',
			 type: 'number',
			 title: 'Power meter off-peak',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'KWh' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_power.producedPeak',
			 type: 'number',
			 title: 'Production peak',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'KWh' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_power.producedOffPeak',
			 type: 'number',
			 title: 'Production off-peak',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'KWh' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'measure_gas',
			 type: 'number',
			 title: 'Gas',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'm³ /hr',
			 decimals: null },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'meter_gas',
			 type: 'number',
			 title: 'Gas Meter',
			 titleTrue: null,
			 titleFalse: null,
			 units: 'm³' },
		 { uri: 'homey:device:ae8202ab-e207-419c-96b0-2723c5873add',
			 id: 'energy_power',
			 type: 'number',
			 title: 'Power usage',
			 units: 'W',
			 decimals: 2 } ],
	color: '#a3df20',
	data: { id: 'LS120P1_72:b8:a:14:26:1b' },
	capabilitiesOptions: undefined }
*/
