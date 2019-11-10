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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('athom-api');

const powerMeterCapabilities = ['meter_power'];

class MeterDriver extends Homey.Driver {

	async onInit() {
		this.log('entering Power by the Hour driver');
		await this.login();
	}

	// login to Homey API
	login() {
		this.api = HomeyAPI.forCurrentHomey();
		return Promise.resolve(this.api);
	}

	onPairListDevices(data, callback) {
		this.log('listing of devices started');
		this.discoverEnergyDevices()
			.then((deviceList) => {
				callback(null, deviceList);
			})
			.catch((error) => {
				callback(error);
			});
	}

	// stuf to find Homey energy devices
	async discoverEnergyDevices() {
		try {
			this.api = await this.login();
			// const homeyInfo = await this.api.system.getInfo();
			this.energyDevices = [];
			const allDevices = await this.api.devices.getDevices();
			const keys = Object.keys(allDevices);
			keys.forEach((key) => {
				const found = powerMeterCapabilities.some((capability) => allDevices[key].capabilities.includes(capability));
				if (found) {
					const device = {
						name: `${allDevices[key].name}_Sum`,
						data: {
							id: `PH_${allDevices[key].id}`,
						},
						settings: {
							homey_device_id: allDevices[key].id,
							homey_device_name: allDevices[key].name,
						},
						capabilities: ['power_hour', 'power_hour_total', 'power_day', 'power_day_total', 'power_month', 'power_month_total'],
					};
					this.energyDevices.push(device);
				}
			});
			return Promise.resolve(this.energyDevices);
		} catch (error) {
			return Promise.reject(error);
		}
	}


}

module.exports = MeterDriver;
