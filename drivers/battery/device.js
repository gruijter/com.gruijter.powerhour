/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

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

const GenericDevice = require('../generic_bat_device');

class batDevice extends GenericDevice {

	onInit() {
		this.onInitDevice();
	}

	async addSourceCapGroup() {
		// setup if/how a HOMEY-API source device fits to a defined capability group
		this.sourceCapGroup = null;
		this.driver.ds.sourceCapGroups.forEach((capGroup) => {
			if (this.sourceCapGroup) return; // stop at the first match
			const requiredKeys = Object.values(capGroup).filter((v) => v);
			const hasAllKeys = requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
			if (hasAllKeys) this.sourceCapGroup = capGroup; // all relevant capabilities were found in the source device
		});
		if (!this.sourceCapGroup) {
			throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
		}
	}

	async addListeners() {
		// check if source device exists
		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false }) // $timeout: 15000
			.catch(this.error);
		const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
			&& Object.keys(this.sourceDevice.capabilitiesObj).length > 0; // && (this.sourceDevice.available !== null);
		if (!sourceDeviceExists) throw Error('Source device is missing.');

		// start listeners for all caps
		await this.addSourceCapGroup();
		this.log(`registering capability listeners for ${this.sourceDevice.name}`);
		Object.keys(this.sourceCapGroup).forEach((key) => {
			if (this.sourceCapGroup[key]) {
				this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], (value) => {
					this.updateValue(value, key);
				});
			}
		});
	}

	async poll() {
		// check if source device exists
		this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false }) // $timeout: 15000
			.catch(this.error);
		const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
			&& Object.keys(this.sourceDevice.capabilitiesObj).length > 0; // && (this.sourceDevice.available !== null);
		if (!sourceDeviceExists) throw Error('Source device is missing.');

		// start polling all caps
		if (!this.sourceCapGroup) await this.addSourceCapGroup();
		this.log(`polling ${this.sourceDevice.name}`);
		Object.keys(this.sourceCapGroup).forEach((key) => {
			if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]]) {
				const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]].value;
				this.updateValue(val, key);
			}
		});
	}

}

module.exports = batDevice;
