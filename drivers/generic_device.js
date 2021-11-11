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

const { Device } = require('homey');
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

class SumMeterDevice extends Device {

	// this method is called when the Device is inited
	async onInitDevice() {
		// this.log('device init: ', this.getName(), 'id:', this.getData().id);
		try {
			// init some stuff
			this.restarting = false;
			await this.migrate();
			this.destroyListeners();
			this.emptyLastReadings();
			this.lastUpdated = 0;
			this.timeZone = this.homey.clock.getTimezone();
			this.sourceDevice = await this.homey.api.devices.getDevice({ id: this.getSettings().homey_device_id });

			// check if source device exists
			const deviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj; // && (this.sourceDevice.available !== null);
			if (!deviceExists) throw Error(`Source device ${this.getName()} is missing`);
			this.setAvailable();

			// init daily resetting source devices
			this.dayStartCumVal = await this.getSettings().meter_day_start;
			this.cumVal = this.dayStartCumVal;
			this.lastAbsVal = 0;

			// init start day and month from settings
			let startDateString = this.getSettings().start_date;
			if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
			this.startDay = Number(startDateString.slice(0, 2));
			this.startMonth = Number(startDateString.slice(2, 4));
			if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
			if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
			this.startMonth -= 1; // January is month 0

			// start poll mode or realtime capability listeners
			const { interval } = this.getSettings();
			if (interval) { this.startPolling(interval); } else this.addListeners();

			// do immediate forced update
			this.pollMeter();
		} catch (error) {
			this.error(error);
			this.setUnavailable(error);
			this.restartDevice(10 * 60 * 1000); // restart after 10 minutes
		}
	}

	// migrate stuff from old version < 3.0.0
	async migrate() {
		try {
			this.log(`checking device capability version for ${this.getName()}`);
			if (this.getSettings().level !== '3.0.0') {
				this.getCapabilities().forEach(async (key) => {
					if (key.includes('_total')) {
						const newKey = `meter_${key}`.replace('_total', '');
						this.log(`migrating capability ${key} to ${newKey} for ${this.getName()}`);
						await this.addCapability(newKey);
						await this.removeCapability(key);
					}
				});
				// set migrate level
				this.setSettings({ level: '3.0.0' });
			}
		} catch (error) {
			this.error('Migration failed', error);
		}
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		this.stopPolling();
		this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!');
		await setTimeoutPromise(dly).then(() => this.onInitDevice());
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
	async onSettings({ newSettings }) { // , oldSettings, changedKeys) {
		this.log('settings change requested by user');
		this.log(newSettings);

		this.log(`${this.getName()} device settings changed`);

		this.lastReadingDay.meterValue = newSettings.meter_day_start;
		await this.setStoreValue('lastReadingDay', this.lastReadingDay);

		this.lastReadingMonth.meterValue = newSettings.meter_month_start;
		await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);

		this.lastReadingYear.meterValue = newSettings.meter_year_start;
		await this.setStoreValue('lastReadingYear', this.lastReadingYear);

		this.restartDevice(1000);
		return Promise.resolve(true);
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
		this.log(`Stop polling ${this.getName()}`);
		this.homey.clearInterval(this.intervalIdDevicePoll);
		this.homey.clearTimeout(this.timeoutIdRestart);
	}

	startPolling(interval) {
		this.homey.clearInterval(this.intervalIdDevicePoll);
		this.log(`start polling ${this.getName()} @${interval} minutes interval`);
		this.intervalIdDevicePoll = this.homey.setInterval(() => {
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

	getReadingObject(value) {
		const date = new Date();
		const dateLocal = new Date(date.toLocaleString('en-UK', { timeZone: this.timeZone }));
		const reading = {
			hour: dateLocal.getHours(),
			day: dateLocal.getDate(),
			month: dateLocal.getMonth(),
			year: dateLocal.getFullYear(),
			meterValue: value,
		};
		return reading;
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

			const reading = this.getReadingObject(value);
			await this.updateStates(reading);
		} catch (error) {
			this.error(error);
		}
	}

	async updateStates(reading) {
		// check app init
		const appInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
		if (appInit) {
			this.log(`${this.getName()} restoring values after app init`);
			this.lastReadingHour = this.getStoreValue('lastReadingHour');
			this.lastReadingDay = this.getStoreValue('lastReadingDay');
			this.lastReadingMonth = this.getStoreValue('lastReadingMonth');
			this.lastReadingYear = this.getStoreValue('lastReadingYear');
			// check pair init
			const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
			if (pairInit) {
				this.log(`${this.getName()} setting values after pair init`);
				await this.setStoreValue('lastReadingHour', reading);
				this.lastReadingHour = reading;
				const dayStart = this.getSettings().homey_device_daily_reset ? this.getReadingObject(0) : reading;
				await this.setStoreValue('lastReadingDay', dayStart);
				this.lastReadingDay = dayStart;
				await this.setStoreValue('lastReadingMonth', reading);
				this.lastReadingMonth = reading;
				await this.setStoreValue('lastReadingYear', reading);
				this.lastReadingYear = reading;
			}
			// set meter start in device settings
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
		}
		// calculate delta
		const valHour = reading.meterValue - this.lastReadingHour.meterValue;
		const valDay = reading.meterValue - this.lastReadingDay.meterValue;
		const valMonth = reading.meterValue - this.lastReadingMonth.meterValue;
		const valYear = reading.meterValue - this.lastReadingYear.meterValue;
		// check for new hour, day, month year
		const newHour = reading.hour !== this.lastReadingHour.hour;
		const newDay = (reading.day !== this.lastReadingDay.day);
		const newMonth = (newDay && (reading.day === this.startDay))
			|| ((reading.day >= this.startDay) && (reading.month > this.lastReadingMonth.month));
		const newYear = (newMonth && (reading.month === this.startMonth))
			|| ((reading.month >= this.startMonth) && (reading.year > this.lastReadingYear.year));
		// set capabilities
		if (!newHour) {
			this.setCapability(this.ds.cmap.this_hour_total, valHour);
		} else {
			// new hour started
			// console.log('new hour started');
			this.setCapability(this.ds.cmap.this_hour_total, 0);
			this.setCapability(this.ds.cmap.last_hour_total, valHour);
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			this.lastReadingHour = reading;
		}
		if (!newDay) {
			this.setCapability(this.ds.cmap.this_day_total, valDay);
		} else {
			// new day started
			this.log('new day started');
			this.setCapability(this.ds.cmap.this_day_total, 0);
			this.setCapability(this.ds.cmap.last_day_total, valDay);
			await this.setStoreValue('lastReadingDay', reading);
			this.lastReadingDay = reading;
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
		}
		if (!newMonth) {
			this.setCapability(this.ds.cmap.this_month_total, valMonth);
		} else {
			// new month started
			this.log('new month started');
			this.setCapability(this.ds.cmap.this_month_total, 0);
			this.setCapability(this.ds.cmap.last_month_total, valMonth);
			await this.setStoreValue('lastReadingMonth', reading);
			this.lastReadingMonth = reading;
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
		}
		if (!newYear) {
			this.setCapability(this.ds.cmap.this_year_total, valYear);
		} else {
			// new year started
			this.log('new year started');
			this.setCapability(this.ds.cmap.this_year_total, 0);
			this.setCapability(this.ds.cmap.last_year_total, valYear);
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
