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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const { Driver } = require('homey');
const crypto = require('crypto');
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

// const battApps = [
// 	'nl.sessy',
// ];

class BatDriver extends Driver {

	async onDriverInit() {
		this.log('onDriverInit');
		// add listener for hourly trigger
		if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
		this.eventListenerHour = async () => {
			// console.log('new hour event received');
			const devices = this.getDevices();
			devices.forEach(async (device) => {
				try {
					const deviceName = device.getName();
					// HOMEY-API device
					// check if source device exists
					const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj && (device.sourceDevice.available !== null);
					if (!sourceDeviceExists) {
						this.error(`Source device ${deviceName} is missing.`);
						await device.setUnavailable('Source device is missing. Retry in 10 minutes.').catch(this.error);
						device.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
						return;
					}
					// poll all capabilities
					await device.poll();
					await device.setAvailable().catch(this.error);
				} catch (error) {
					this.error(error);
				}
			});
		};
		this.homey.on('everyhour', this.eventListenerHour);

		// add listener for 5 minute retry
		if (this.eventListenerRetry) this.homey.removeListener('retry', this.eventListenerRetry);
		this.eventListenerRetry = async () => {
			const devices = this.getDevices();
			devices.forEach(async (device) => {
				try {
					const deviceName = device.getName();
					if (device.migrating || device.restarting) return;
					if (!device.initReady) {
						this.log(`${deviceName} Restarting now`);
						// device.onInit();
						device.restartDevice(500).catch(this.error);
					}
					// HOMEY-API device - check if source device exists
					const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
						&& Object.keys(this.sourceDevice.capabilitiesObj).length > 0 && (this.sourceDevice.available !== null);
					if (!sourceDeviceExists) {
						this.error(`Source device ${deviceName} is missing. Restarting now.`);
						await device.setUnavailable('Source device is missing. Retrying ..').catch(this.error);
						device.restartDevice(500).catch(this.error);
					}
				} catch (error) {
					this.error(error);
				}
			});
		};
		this.homey.on('retry', this.eventListenerRetry);

		// add listener for new prices
		const eventName = 'set_tariff_power';
		if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
		this.eventListenerTariff = async (args) => {
			// console.log(`${eventName} received from DAP`, args);
			// eslint-disable-next-line prefer-destructuring
			const pricesNextHours = args.pricesNextHours;
			if (!pricesNextHours || !pricesNextHours[0]) {
				this.log('no prices next hours found');
				return;
			}
			const group = args.group || 1; // default to group 1 if not filled in
			// wait 2 seconds not to stress Homey and prevent race issues
			await setTimeoutPromise(2 * 1000);
			const devices = this.getDevices();
			devices.forEach((device) => {
				if (device.settings && device.settings.tariff_update_group && device.settings.tariff_update_group === group) {
					const deviceName = device.getName();
					this.log('updating prices', deviceName, pricesNextHours[0]);
					device.updatePrices([...pricesNextHours]);
				}
			});
		};
		this.homey.on(eventName, this.eventListenerTariff);
	}

	async onUninit() {
		this.log('bat driver onUninit called');
		if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
		if (this.eventListenerRetry) this.homey.removeListener('retry', this.eventListenerRetry);
		const eventName = 'set_tariff_power';
		if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
		await setTimeoutPromise(3000);
	}

	// stuff to find Homey battery devices
	async onPairListDevices() {
		try {
			this.log('listing of devices started');
			const randomId = crypto.randomBytes(3).toString('hex');
			this.devices = [];

			const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 20000 });
			const keys = Object.keys(allDevices);
			const allCaps = this.ds.deviceCapabilities;
			keys.forEach((key) => {
				const hasCapability = (capability) => allDevices[key].capabilities.includes(capability);
				let found = this.ds.originDeviceCapabilities.some(hasCapability);
				// check for compatible sourceCapGroup in app sources
				let hasSourceCapGroup = false;
				if (found) {
					this.ds.sourceCapGroups.forEach((capGroup) => {
						if (hasSourceCapGroup) return; // stop at the first match
						const requiredKeys = Object.values(capGroup).filter((v) => v);
						const hasAllKeys = requiredKeys.every((k) => allDevices[key].capabilities.includes(k));
						if (hasAllKeys) hasSourceCapGroup = true; // all relevant capabilities were found in the source device
					});
					found = hasSourceCapGroup;
				}
				if (found) {
					const device = {
						name: `${allDevices[key].name}_Σ`,
						data: {
							id: `PH_${this.ds.driverId}_${allDevices[key].id}_${randomId}`,
						},
						settings: {
							homey_device_id: allDevices[key].id,
							homey_device_name: allDevices[key].name,
							level: this.homey.app.manifest.version,
							tariff_update_group: 1,
						},
						capabilities: allCaps,
					};
					this.devices.push(device);
				}
			});
			return Promise.all(this.devices);
		} catch (error) {
			return Promise.reject(error);
		}
	}

}

module.exports = BatDriver;
