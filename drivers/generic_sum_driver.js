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
			devices.forEach(async (device) => {
				try {
					const deviceName = device.getName();
					// devices that always need an immediate poll
					// HOMEY_ENERGY device
					if (device.getSettings().homey_energy) {
						await device.pollMeter();
						return;
					}

					// devices that might get udated without forced poll

					// METER_VIA_FLOW device
					if (device.getSettings().meter_via_flow) {
						await device.updateMeterFromFlow(null);
						return;
					}

					// HOMEY-API device
					// check if source device exists
					const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj && (device.sourceDevice.available !== null);
					if (!sourceDeviceExists) {
						this.error(`Source device ${deviceName} is missing.`);
						await device.setUnavailable('Source device is missing. Retry in 10 minutes.');
						device.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
						return;
					}

					// METER_VIA_WATT device
					if (device.driver.id === 'power' && device.getSettings().use_measure_source) {
						await device.updateMeterFromMeasure(null);
						return;
					}

					// check if listener or polling is on, otherwise restart device
					const ignorePollSetting = !device.getSettings().meter_via_flow && !device.getSettings().use_measure_source;
					const pollingIsOn = !!device.getSettings().interval && device.intervalIdDevicePoll
						&& (device.intervalIdDevicePoll._idleTimeout > 0); // polling is on
					const listeningIsOn = Object.keys(device.capabilityInstances).length > 0; // listener is on

					if (ignorePollSetting && !pollingIsOn && !listeningIsOn) {
						this.error(`${deviceName} is not in polling or listening mode. Restarting now..`);
						device.restartDevice(1000).catch(this.error);
						return;
					}

					// check if source device is available
					if (!device.sourceDevice.available) {
						this.error(`Source device ${deviceName} is unavailable.`);
						// device.setUnavailable('Source device is unavailable');
						device.log('trying hourly poll', deviceName);
						await device.pollMeter();
						return;
					}

					// force poll, unless wait for listener is setup
					let doPoll = true;
					if (device.getSettings().wait_for_update) {
						const waitTime = device.getSettings().wait_for_update * 60 * 1000;
						await setTimeoutPromise(waitTime);
						// check if new hour was already registered
						const now = new Date();
						const lastReadingTm = new Date(device.lastReadingHour.meterTm);
						if (now.getHours() === lastReadingTm.getHours()) doPoll = false;
					}
					if (doPoll) {
						device.log('doing hourly poll', deviceName);
						await device.pollMeter();
					}
					await device.setAvailable();
				} catch (error) {
					this.error(error);
				}
			});
		};
		this.homey.on('everyhour', this.eventListenerHour);

		// add listener for tariff change
		const eventName = `set_tariff_${this.id}`;
		if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
		this.eventListenerTariff = async (args) => {
			this.log(`${eventName} received from flow or DAP`, args);
			const currentTm = new Date();
			const tariff = args.tariff === null ? null : Number(args.tariff);
			const group = args.group || 1; // default to group 1 if not filled in
			if (!Number.isFinite(tariff)) {
				this.error('the tariff is not a valid number');
				return;
			}
			// wait 2 seconds not to stress Homey and prevent race issues
			await setTimeoutPromise(2 * 1000);
			const devices = this.getDevices();
			devices.forEach((device) => {
				if (device.settings && device.settings.tariff_update_group && device.settings.tariff_update_group === group) {
					const deviceName = device.getName();
					this.log('updating tariff', deviceName, tariff);
					device.updateTariffHistory(tariff, currentTm);
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
			this.devices = [];

			const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 20000 });
			const keys = Object.keys(allDevices);
			const allCaps = this.ds.deviceCapabilities;
			const reducedCaps = allCaps.filter((cap) => !cap.includes('meter_target'));
			keys.forEach((key) => {
				const hasCapability = (capability) => allDevices[key].capabilities.includes(capability);
				let found = this.ds.originDeviceCapabilities.some(hasCapability);

				// check for compatible sourceCapGroup in power sources
				let hasSourceCapGroup = false;
				let useMeasureSource = false;
				if (found && this.ds.driverId === 'power') {
					this.ds.sourceCapGroups.forEach((capGroup) => {
						if (hasSourceCapGroup) return; // stop at the first match
						const requiredKeys = Object.values(capGroup).filter((v) => v);
						const hasAllKeys = requiredKeys.every((k) => allDevices[key].capabilities.includes(k));
						if (hasAllKeys) hasSourceCapGroup = true; // all relevant capabilities were found in the source device
					});
					if (!hasSourceCapGroup && !allDevices[key].capabilities.includes('measure_power')) {
						this.log('incompatible source caps', allDevices[key].driverUri, allDevices[key].capabilities);
						found = false;
					}
					useMeasureSource = !hasSourceCapGroup;
				}
				if (found) {
					const device = {
						name: `${allDevices[key].name}_Σ${this.ds.driverId}`,
						data: {
							id: `PH_${this.ds.driverId}_${allDevices[key].id}_${randomId}`,
						},
						settings: {
							homey_device_id: allDevices[key].id,
							homey_device_name: allDevices[key].name,
							level: this.homey.app.manifest.version,
							source_device_type: 'Homey device',
							use_measure_source: useMeasureSource,
							tariff_update_group: 1,
							distribution: 'NONE',
						},
						capabilities: allCaps,
					};
					if (dailyResetApps.some((appId) => allDevices[key].driverUri.includes(appId))) {
						device.settings.homey_device_daily_reset = true;
					}
					if (allDevices[key].energyObj && allDevices[key].energyObj.cumulative) device.settings.distribution = 'el_nl_2023';
					if (this.ds.driverId === 'gas') device.settings.distribution = 'gas_nl_2023';
					if (this.ds.driverId === 'water') device.settings.distribution = 'linear';
					if (!(allDevices[key].driverUri.includes('com.gruijter.powerhour')	// ignore own app devices
						|| allDevices[key].driverId === 'homey')) this.devices.push(device);	// ignore homey virtual power device
					if (device.settings.distribution === 'NONE') device.capabilities = reducedCaps;
				}
			});
			// show cumulative devices first ('NONE' is smaller than 'el_nl_2023')
			this.devices.sort((a, b) => -1 * (a.settings.distribution > b.settings.distribution));

			// add Homey Energy virtual devices
			if (this.ds.driverId === 'power') {
				this.devices.push(
					{
						name: `HOMEY_ENERGY_SMARTMETERS_Σ${this.ds.driverId}`,
						data: {
							id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
						},
						settings: {
							homey_device_id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
							homey_device_name: `HOMEY_ENERGY_CUMULATIVE_${randomId}`,
							level: this.homey.app.manifest.version,
							homey_energy: 'totalCumulative',
							interval: 1,
							source_device_type: 'Homey Energy Smart Meters',
							tariff_update_group: 1,
							distribution: 'linear',
						},
						capabilities: allCaps,
					},
					{
						name: `HOMEY_ENERGY_SOLARPANELS_Σ${this.ds.driverId}`,
						data: {
							id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
						},
						settings: {
							homey_device_id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
							homey_device_name: `HOMEY_ENERGY_GENERATED_${randomId}`,
							level: this.homey.app.manifest.version,
							homey_energy: 'totalGenerated',
							interval: 1,
							source_device_type: 'Homey Energy Solar Panels',
							tariff_update_group: 1,
							distribution: 'NONE',
						},
						capabilities: reducedCaps,
					},
					{
						name: `HOMEY_ENERGY_DEVICES_Σ${this.ds.driverId}`,
						data: {
							id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
						},
						settings: {
							homey_device_id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
							homey_device_name: `HOMEY_ENERGY_DEVICES_${randomId}`,
							level: this.homey.app.manifest.version,
							homey_energy: 'totalConsumed',
							interval: 1,
							source_device_type: 'Homey Energy Devices',
							tariff_update_group: 1,
							distribution: 'NONE',
						},
						capabilities: reducedCaps,
					},
				);
			}

			// add virtual device
			this.devices.push(
				{
					name: `VIRTUAL_VIA_FLOW_Σ${this.ds.driverId}`,
					data: {
						id: `PH_${this.ds.driverId}_${randomId}`,
					},
					settings: {
						homey_device_id: `PH_${this.ds.driverId}_${randomId}`,
						homey_device_name: `VIRTUAL_METER_${randomId}`,
						level: this.homey.app.manifest.version,
						source_device_type: 'virtual via flow',
						meter_via_flow: true,
						tariff_update_group: 1,
						distribution: 'NONE',
					},
					capabilities: reducedCaps,
				},
			);

			return Promise.resolve(this.devices);
		} catch (error) {
			return Promise.reject(error);
		}
	}

}

module.exports = SumMeterDriver;
