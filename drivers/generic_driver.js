/* eslint-disable import/no-extraneous-dependencies */
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

const Homey = require('homey');
const { HomeyAPI } = require('athom-api');

class SumMeterDriver extends Homey.Driver {

	async onDriverInit() {
		this.log('onDriverInit');
		await this.login();
		Homey.on('everyhour', async () => {
			const devices = this.getDevices();
			devices.forEach((device) => {
				device.updateMeterCron();
			});
		});
	}

	// login to Homey API
	login() {
		this.api = HomeyAPI.forCurrentHomey();
		return Promise.resolve(this.api);
	}

	onPairListDevices(data, callback) {
		this.log('listing of devices started');
		this.discoverDevices()
			.then((deviceList) => {
				callback(null, deviceList);
			})
			.catch((error) => {
				callback(error);
			});
	}

	// stuff to find Homey devices
	async discoverDevices() {
		try {
			this.api = await this.login();
			// const homeyInfo = await this.api.system.getInfo();
			this.devices = [];
			const allDevices = await this.api.devices.getDevices();
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
						},
						capabilities: this.ds.deviceCapabilities,
					};
					this.devices.push(device);
				}
			});
			return Promise.resolve(this.devices);
		} catch (error) {
			return Promise.reject(error);
		}
	}


}

module.exports = SumMeterDriver;
