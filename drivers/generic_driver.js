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

const dailyResetApps = [
	'com.tibber',
	'it.diederik.solar',
];

class SumMeterDriver extends Driver {

	async onDriverInit() {
		this.log('onDriverInit');

		// add listener for hourly trigger
		if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
		this.eventListenerHour = async () => {
			// console.log('new hour event received');
			const devices = this.getDevices();
			devices.forEach((device) => {
				const deviceName = device.getName();
				// check for METER_VIA_FLOW device
				if (device.getSettings().meter_via_flow) {
					device.updateMeterFromFlow(null);
					return;
				}
				// check if source device exists
				const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj && (device.sourceDevice.available !== null);
				if (!sourceDeviceExists) {
					this.error(`Source device ${deviceName} is missing.`);
					device.setUnavailable('Source device is missing. Retry in 10 minutes.');
					device.restartDevice(10 * 60 * 1000); // restart after 10 minutes
					return;
				}
				// check for METER_VIA_WATT
				if (device.getSettings().use_measure_source) {
					device.updateMeterFromMeasure(null);
					return;
				}
				// check if listener or polling is on, otherwise restart device
				const ignorePollSetting = !device.getSettings().meter_via_flow && !device.getSettings().use_measure_source;
				const pollingIsOn = !!device.getSettings().interval && device.intervalIdDevicePoll && (device.intervalIdDevicePoll._idleTimeout > 0);
				const listeningIsOn = Object.keys(device.capabilityInstances).length > 0;
				if (ignorePollSetting && !pollingIsOn && !listeningIsOn) {
					this.error(`${deviceName} is not in polling or listening mode. Restarting now..`);
					device.restartDevice(1000);
					return;
				}
				// force immediate update
				device.pollMeter();
				// check if source device is available
				if (!device.sourceDevice.available) {
					this.error(`Source device ${deviceName} is unavailable.`);
					// device.setUnavailable('Source device is unavailable');
					return;
				}
				device.setAvailable();
			});
		};
		this.homey.on('everyhour', this.eventListenerHour);

		// add listener for tariff change
		const eventName = `set_tariff_${this.id}`;
		if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
		this.eventListenerTariff = (args) => {
			this.log(`${eventName} received from flow`, args);
			// this.activeTariff = args.tariff;
			const devices = this.getDevices();
			devices.forEach((device) => {
				if (device.settings.tariff_via_flow) {
					const deviceName = device.getName();
					this.log('updating tariff', deviceName, args.tariff);
					const self = device;
					self.tariff = args.tariff; // { tariff: 0.25 }
					self.setSettings({ tariff: args.tariff });
					self.setCapability('meter_tariff', args.tariff);
				}
			});
		};
		this.homey.on(eventName, this.eventListenerTariff);

	}

	async onPairListDevices() {
		this.log('listing of devices started');
		return this.discoverDevices();
	}

	// stuff to find Homey devices
	async discoverDevices() {
		try {
			const randomId = crypto.randomBytes(3).toString('hex');
			const virtualDevice = {
				name: `VIRTUAL_METER_Σ${this.ds.driverId}`,
				data: {
					id: `PH_${this.ds.driverId}_${randomId}`,
				},
				settings: {
					homey_device_id: `PH_${this.ds.driverId}_${randomId}`,
					homey_device_name: `VIRTUAL_METER_${randomId}`,
					level: this.homey.app.manifest.version,
					meter_via_flow: true,
					source_device_type: 'virtual via flow',
				},
				capabilities: this.ds.deviceCapabilities,
			};
			this.devices = [];
			const allDevices = await this.homey.app.api.devices.getDevices();
			const keys = Object.keys(allDevices);
			keys.forEach((key) => {
				const hasCapability = (capability) => allDevices[key].capabilities.includes(capability);
				const found = this.ds.originDeviceCapabilities.some(hasCapability);
				if (found) {
					const device = {
						name: `${allDevices[key].name}_Σ${this.ds.driverId}`,
						data: {
							id: `PH_${this.ds.driverId}_${allDevices[key].id}`,
						},
						settings: {
							homey_device_id: allDevices[key].id,
							homey_device_name: allDevices[key].name,
							level: this.homey.app.manifest.version,
						},
						capabilities: this.ds.deviceCapabilities,
					};
					if (!allDevices[key].capabilities.toString().includes('meter_')) device.settings.use_measure_source = true;
					if (dailyResetApps.some((appId) => allDevices[key].driverUri.includes(appId))) {
						device.settings.homey_device_daily_reset = true;
					}
					if (!allDevices[key].driverUri.includes('com.gruijter.powerhour')) this.devices.push(device);
				}
			});
			this.devices.push(virtualDevice);
			return Promise.resolve(this.devices);
		} catch (error) {
			return Promise.reject(error);
		}
	}

}

module.exports = SumMeterDriver;
