/* eslint-disable camelcase */
/* eslint-disable import/no-extraneous-dependencies */
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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');

const getReadingObject = (value) => {
	const ts = new Date();
	const reading = {
		hour: ts.getHours(),
		day: ts.getDate(),
		month: ts.getMonth(),
		year: ts.getFullYear(),
		meterValue: value,
	};
	return reading;
};

class SumMeterDevice extends Homey.Device {

	// this method is called when the Device is inited
	async onInitDevice() {
		// this.log('device init: ', this.getName(), 'id:', this.getData().id);
		try {
			// init some stuff
			this.destroyListeners();
			this.emptyLastReadings();
			this._driver = await this.getDriver();
			await this._driver.ready(() => this.log(`${this.getName()} driver is loaded`));
			this.lastUpdated = 0;
			this.sourceDevice = await this.getSourceDevice();
			// check if source device is available
			if (!this.sourceDevice || !this.sourceDevice.capabilitiesObj) {
				this.error(`Source device ${this.getName()} is not available`);
				this.setUnavailable('Source device is not available');
				return;
			}
			this.setAvailable();

			// init daily resetting source devices
			this.dayStartCumVal = await this.getSettings().meter_day_start;
			this.cumVal = this.dayStartCumVal;
			this.lastAbsVal = 0;

			const { interval } = this.getSettings();
			// start poll mode
			if (interval) this.startPolling(interval);
			// start realtime capability listeners
			if (!interval) this.addListeners();

			this.pollMeter();
		} catch (error) {
			this.error(error);
			this.setUnavailable(error);
			this.restartDevice(60000);
		}
	}

	restartDevice(delay) {
		this.log(`Restarting device in ${delay / 1000} seconds`);
		this.stopPolling();
		this.destroyListeners();
		setTimeout(() => {
			this.onInitDevice();
		}, delay || 10000);
	}

	// this method is called when the Device is added
	async onAdded() {
		this.log(`Meter added as device: ${this.getName()}`);
	}

	// this method is called when the Device is deleted
	onDeleted() {
		this.stopPolling();
		this.destroyListeners();
		this.log(`Meter deleted as device: ${this.getName()}`);
	}

	onRenamed(name) {
		this.log(`Meter renamed to: ${name}`);
	}

	// this method is called when the user has changed the device's settings in Homey.
	async onSettings(oldSettingsObj, newSettingsObj) { // , changedKeysArr) {
		this.log('settings change requested by user');
		this.log(newSettingsObj);
		// this.log(newSettingsObj);
		this.log(`${this.getName()} device settings changed`);

		this.lastReadingDay.meterValue = newSettingsObj.meter_day_start;
		await this.setStoreValue('lastReadingDay', this.lastReadingDay);

		this.lastReadingMonth.meterValue = newSettingsObj.meter_month_start;
		await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);

		this.lastReadingYear.meterValue = newSettingsObj.meter_year_start;
		await this.setStoreValue('lastReadingYear', this.lastReadingYear);

		this.restartDevice(1000);
		return Promise.resolve(true);
	}

	async getSourceDevice() {
		this.api = await this._driver.api;
		this.sourceDevice = await this.api.devices.getDevice({ id: this.getSettings().homey_device_id });
		return Promise.resolve(this.sourceDevice);
	}

	async destroyListeners() {
		if (this.capabilityInstances && Object.entries(this.capabilityInstances).length > 0) {
			// this.log('Destroying capability listeners');
			Object.entries(this.capabilityInstances).forEach((entry) => {
				this.log(`Destroying capability listener ${entry[0]}`);
				entry[1].destroy();
			});
		}
		this.capabilityInstances = {};
	}

	stopPolling() {
		this.log('Stop polling');
		clearInterval(this.intervalIdDevicePoll);
	}

	startPolling(interval) {
		clearInterval(this.intervalIdDevicePoll);
		this.log(`start polling @${interval} minutes interval`);
		this.intervalIdDevicePoll = setInterval(() => {
			this.pollMeter();
		}, 1000 * 60 * interval);
	}

	emptyLastReadings() {
		this.lastReadingHour = null;
		this.lastReadingDay = null;
		this.lastReadingMonth = null;
		this.lastReadingYear = null;
	}

	setCapability(capability, value) {
		if (this.hasCapability(capability)) {
			// only update changed capabilities
			if (value !== this.getCapabilityValue(capability)) {
				this.setCapabilityValue(capability, value)
					.catch((error) => {
						this.log(error, capability, value);
					});
			}
		}
	}

	async updateMeter(val) {
		try {
			let value = val;

			// logic for daily resetting meters
			if (this.getSettings().homey_device_daily_reset) {
				// detect reset
				const absVal = Math.abs(value);
				const reset = ((absVal < this.lastAbsVal) && (absVal < 0.1));
				this.lastAbsVal = absVal;
				if (reset) {
					this.log('source device meter reset detected');
					this.dayStartCumVal = this.cumVal;
					await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
					this.cumVal += absVal;
				} else {
					this.cumVal = this.dayStartCumVal + absVal;
				}
				value = this.cumVal;
			}

			const reading = getReadingObject(value);
			await this.updateHour(reading);
			await this.updateDay(reading);
			await this.updateMonth(reading);
			await this.updateYear(reading);
		} catch (error) {
			this.error(error);
		}
	}

	async updateHour(reading) {
		if (!this.lastReadingHour) {	// after init
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			this.lastReadingHour = this.getStoreValue('lastReadingHour');
			if (!this.lastReadingHour) {	// after new pair
				await this.setStoreValue('lastReadingHour', reading);
				this.lastReadingHour = reading;
			}
		}
		const val = reading.meterValue - this.lastReadingHour.meterValue;
		if ((reading.day === this.lastReadingHour.day) && (reading.hour === this.lastReadingHour.hour)) {
			this.setCapability(this.ds.cmap.this_hour_total, val);
		} else {
			// new hour started
			this.setCapability(this.ds.cmap.this_hour_total, 0);
			this.setCapability(this.ds.cmap.last_hour_total, val);
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			this.lastReadingHour = reading;
		}
	}

	async updateDay(reading) {
		if (!this.lastReadingDay) {	// after init
			this.lastReadingDay = this.getStoreValue('lastReadingDay');
			if (!this.lastReadingDay) {	// after new pair
				const start = this.getSettings().homey_device_daily_reset ? getReadingObject(0) : reading;
				await this.setStoreValue('lastReadingDay', start);
				this.lastReadingDay = start;
			}
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
		}
		const val = reading.meterValue - this.lastReadingDay.meterValue;
		if ((reading.month === this.lastReadingDay.month) && (reading.day === this.lastReadingDay.day)) {
			this.setCapability(this.ds.cmap.this_day_total, val);
		} else {
			// new day started
			this.setCapability(this.ds.cmap.this_day_total, 0);
			this.setCapability(this.ds.cmap.last_day_total, val);
			await this.setStoreValue('lastReadingDay', reading);
			this.lastReadingDay = reading;
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
		}
	}

	async updateMonth(reading) {
		if (!this.lastReadingMonth) {	// after init
			this.lastReadingMonth = this.getStoreValue('lastReadingMonth');
			if (!this.lastReadingMonth) {	// after new pair
				await this.setStoreValue('lastReadingMonth', reading);
				this.lastReadingMonth = reading;
			}
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
		}
		const val = reading.meterValue - this.lastReadingMonth.meterValue;
		if ((reading.month === this.lastReadingMonth.month)) {
			this.setCapability(this.ds.cmap.this_month_total, val);
		} else {
			// new month started
			this.setCapability(this.ds.cmap.this_month_total, 0);
			this.setCapability(this.ds.cmap.last_month_total, val);
			await this.setStoreValue('lastReadingMonth', reading);
			this.lastReadingMonth = reading;
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
		}
	}

	async updateYear(reading) {
		if (!this.lastReadingYear) {	// after init
			this.lastReadingYear = this.getStoreValue('lastReadingYear');
			if (!this.lastReadingYear) {	// after new pair
				await this.setStoreValue('lastReadingYear', reading);
				this.lastReadingYear = reading;
			}
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
		}
		const val = reading.meterValue - this.lastReadingYear.meterValue;
		if ((reading.year === this.lastReadingYear.year)) {
			this.setCapability(this.ds.cmap.this_year_total, val);
		} else {
			// new year started
			this.setCapability(this.ds.cmap.this_year_total, 0);
			this.setCapability(this.ds.cmap.last_year_total, val);
			await this.setStoreValue('lastReadingYear', reading);
			this.lastReadingYear = reading;
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
		}
	}

}

module.exports = SumMeterDevice;

/*
{ hour: 10,
	day: 8,
	month: 2,
	year: 2020,
	meterValue: 639.7536 }
*/
