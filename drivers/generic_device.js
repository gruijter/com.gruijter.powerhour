/* eslint-disable camelcase */
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
			this._driver = await this.getDriver();
			// this.settings = await this.getSettings();
			this.sourceDevice = await this.getSourceDevice();
			this.emptyLastReadings();
			// start listening to device and update info
			this.destroyListeners();
			this.addListeners();
			this.pollMeter();
		} catch (error) {
			this.error(error);
		}
	}

	restartDevice(delay) {
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

		this.lastReadingMonth.meterValue = newSettingsObj.meter_month_start;
		await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);

		this.lastReadingYear.meterValue = newSettingsObj.meter_year_start;
		await this.setStoreValue('lastReadingYear', this.lastReadingYear);

		this.restartDevice(1000);
		// do callback to confirm settings change
		return Promise.resolve(true);
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

	emptyLastReadings() {
		this.lastReadingHour = null;
		this.lastReadingDay = null;
		this.lastReadingMonth = null;
		this.lastReadingYear = null;
	}

	updateMeterCron() {
		this.pollMeter();
	}

	async updateMeter(val) {
		try {
			let value = val;
			if (this.lastReadingDay && this.getSettings().homey_device_daily_reset) {
				value = val + this.lastReadingDay.meterValue;
			}
			const reading = getReadingObject(value);
			await this.updateHour(reading);
			await this.updateDay(reading);
			await this.updateMonth(reading);
			await this.updateYear(reading);
			await this.setSettings({ meter_latest: `${value}` });
		} catch (error) {
			this.error(error);
		}
	}

	async updateHour(reading) {
		if (!this.lastReadingHour) {	// after init
			this.lastReadingHour = this.getStoreValue('lastReadingHour');
			if (!this.lastReadingHour) {	// after new pair
				await this.setStoreValue('lastReadingHour', reading);
				this.lastReadingHour = reading;
			}
		}
		const val = reading.meterValue - this.lastReadingHour.meterValue;
		if ((reading.day === this.lastReadingHour.day) && (reading.hour === this.lastReadingHour.hour)) {
			this.setCapabilityValue(this.ds.cmap.this_hour_total, val);
		} else {
			// new hour started
			this.setCapabilityValue(this.ds.cmap.this_hour_total, 0);
			this.setCapabilityValue(this.ds.cmap.last_hour_total, val);
			await this.setStoreValue('lastReadingHour', reading);
			this.lastReadingHour = reading;
		}
	}

	async updateDay(reading) {
		if (!this.lastReadingDay) {	// after init
			this.lastReadingDay = this.getStoreValue('lastReadingDay');
			if (!this.lastReadingDay) {	// after new pair
				const start = this.getSettings().homey_device_daily_reset ? 0 : reading;
				await this.setStoreValue('lastReadingDay', start);
				this.lastReadingDay = start;
			}
		}
		const val = reading.meterValue - this.lastReadingDay.meterValue;
		if ((reading.month === this.lastReadingDay.month) && (reading.day === this.lastReadingDay.day)) {
			this.setCapabilityValue(this.ds.cmap.this_day_total, val);
		} else {
			// new day started
			this.setCapabilityValue(this.ds.cmap.this_day_total, 0);
			this.setCapabilityValue(this.ds.cmap.last_day_total, val);
			await this.setStoreValue('lastReadingDay', reading);
			this.lastReadingDay = reading;
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
			this.setCapabilityValue(this.ds.cmap.this_month_total, val);
		} else {
			// new month started
			this.setCapabilityValue(this.ds.cmap.this_month_total, 0);
			this.setCapabilityValue(this.ds.cmap.last_month_total, val);
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
			this.setCapabilityValue(this.ds.cmap.this_year_total, val);
		} else {
			// new year started
			this.setCapabilityValue(this.ds.cmap.this_year_total, 0);
			this.setCapabilityValue(this.ds.cmap.last_year_total, val);
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
