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
			this.destroyListeners();
			this.settings = await this.getSettings();
			await this.migrate();
			this.emptyLastReadings();
			this.lastUpdated = 0;
			this.timeZone = this.homey.clock.getTimezone();

			// await setTimeoutPromise(10 * 1000); // wait a bit for Homey to settle?
			this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.settings.homey_device_id, $cache: false });

			// check if source device exists
			const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj; // && (this.sourceDevice.available !== null);
			if (!sourceDeviceExists) throw Error(`Source device ${this.getName()} is missing`);
			// check if source device is ready
			if (!this.sourceDevice) throw Error(`Source device ${this.getName()} is not ready`);
			// if (!this.sourceDevice || this.sourceDevice.ready !== true) throw Error(`Source device ${this.getName()} is not ready`);
			this.setAvailable();

			// init daily resetting source devices
			this.dayStartCumVal = this.settings.meter_day_start;
			this.cumVal = this.dayStartCumVal;
			this.lastAbsVal = 0;

			// init tariff and start day and month from settings
			let startDateString = this.settings.start_date;
			if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
			this.startDay = Number(startDateString.slice(0, 2));
			this.startMonth = Number(startDateString.slice(2, 4));
			if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
			if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
			this.startMonth -= 1; // January is month 0
			this.tariff = this.tariff || this.settings.tariff;

			// start poll mode or realtime capability listeners
			const { interval } = this.settings;
			if (interval) { this.startPolling(interval); } else this.addListeners();

			// do immediate forced update
			this.pollMeter();
		} catch (error) {
			this.error(error);
			this.setUnavailable(error);
			this.restartDevice(10 * 60 * 1000); // restart after 10 minutes
		}
	}

	// migrate stuff from old version < 3.4.0
	async migrate() {
		try {
			this.log(`checking device migration version for ${this.getName()}`);
			if (this.settings.level !== this.homey.app.manifest.version) {
				const existingCapabilities = this.getCapabilities();
				// rename pre-3.0.0 capabilities
				existingCapabilities.forEach(async (key) => {
					if (key.includes('_total')) {
						const newKey = `meter_${key}`.replace('_total', '');
						this.log(`migrating capability ${key} to ${newKey} for ${this.getName()}`);
						await this.addCapability(newKey);
						await this.removeCapability(key);
					}
				});
				// add new 3.4.0 capabilities
				const newCaps = ['meter_money_this_hour', 'meter_money_this_day', 'meter_money_this_month', 'meter_money_this_year', 'meter_tariff'];
				newCaps.forEach(async (newCapability) => {
					if (!existingCapabilities.includes(newCapability)) {
						this.log(`adding new capability ${newCapability} for ${this.getName()}`);
						await this.addCapability(newCapability);
					}
				});
				// set migrate level
				this.setSettings({ level: this.homey.app.manifest.version });
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
	async onSettings({ newSettings, changedKeys }) { // , oldSettings, changedKeys) {
		this.log('settings change requested by user');
		this.log(newSettings);

		this.log(`${this.getName()} device settings changed`);

		if (changedKeys.includes('meter_day_start')) {
			this.lastReadingDay.meterValue = newSettings.meter_day_start;
			await this.setStoreValue('lastReadingDay', this.lastReadingDay);
		}
		if (changedKeys.includes('meter_month_start')) {
			this.lastReadingMonth.meterValue = newSettings.meter_month_start;
			await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
		}
		if (changedKeys.includes('meter_month_start')) {
			this.lastReadingYear.meterValue = newSettings.meter_year_start;
			await this.setStoreValue('lastReadingYear', this.lastReadingYear);
		}

		const money = this.lastMoney;
		if (changedKeys.includes('meter_money_this_day')) {
			money.day = newSettings.meter_money_this_day;
		}
		if (changedKeys.includes('meter_money_this_month')) {
			money.month = newSettings.meter_money_this_month;
		}
		if (changedKeys.includes('meter_money_this_year')) {
			money.year = newSettings.meter_money_this_year;
		}
		if (changedKeys.toString().includes('meter_money_')) {
			await this.updateMoneyCapabilities(money);
			this.lastMoney = money;
			await this.setStoreValue('lastMoney', this.lastMoney);
		}

		if (changedKeys.includes('tariff')) {
			this.tariff = newSettings.tariff;
		}

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
			try {
				this.pollMeter();
			} catch (error) {
				this.error(error);
				this.setUnavailable(error);
				this.restartDevice(10 * 60 * 1000); // restart after 10 minutes
			}
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

	async getReadingObject(value) {
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
			if (this.settings.homey_device_daily_reset) {
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

			const reading = await this.getReadingObject(value);
			await this.updateMeters(reading);
		} catch (error) {
			this.error(error);
		}
	}

	async updateMeters(reading) {
		// init some money stuff
		// check pair init or app money migration
		if (!this.lastMoney) this.lastMoney = await this.getStoreValue('lastMoney');
		if (!this.lastMoney) {
			this.log(`${this.getName()} setting money values after pair init or app migration`);
			this.lastMoney = {
				hour: this.tariff * this.getCapabilityValue(this.ds.cmap.this_hour),	// assume same tariff all hour
				day: this.tariff * this.getCapabilityValue(this.ds.cmap.this_day),	// assume same tariff all day
				month: this.tariff * this.getCapabilityValue(this.ds.cmap.this_month),	// assume same tariff all month
				year: this.tariff * this.getCapabilityValue(this.ds.cmap.this_year),	// assume same tariff all year
				meterValue: reading.meterValue,	// current meter value.
			};
			// Update settings
			await this.setSettings({ meter_money_this_day: this.lastMoney.day });
			await this.setSettings({ meter_money_this_month: this.lastMoney.month });
			await this.setSettings({ meter_money_this_year: this.lastMoney.year });
		}

		// check app init
		if (!this.available) this.setAvailable();
		const appInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
		if (appInit) {
			this.log(`${this.getName()} restoring meter values after app init`);
			this.lastReadingHour = await this.getStoreValue('lastReadingHour');
			this.lastReadingDay = await this.getStoreValue('lastReadingDay');
			this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
			this.lastReadingYear = await this.getStoreValue('lastReadingYear');
			// check pair init
			const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
			if (pairInit) {
				this.log(`${this.getName()} setting values after pair init`);
				await this.setStoreValue('lastReadingHour', reading);
				this.lastReadingHour = reading;
				const dayStart = this.settings.homey_device_daily_reset ? this.getReadingObject(0) : reading;
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

		// calculate money
		const deltaMoney = (reading.meterValue - this.lastMoney.meterValue) * this.tariff;
		const money = {
			hour: this.lastMoney.hour + deltaMoney,
			day: this.lastMoney.day + deltaMoney,
			month: this.lastMoney.month + deltaMoney,
			year: this.lastMoney.year + deltaMoney,
			meterValue: reading.meterValue,
		};

		// check for new hour, day, month year
		const newHour = reading.hour !== this.lastReadingHour.hour;
		const newDay = (reading.day !== this.lastReadingDay.day);
		const newMonth = (newDay && (reading.day === this.startDay))
			|| ((reading.day >= this.startDay) && (reading.month > this.lastReadingMonth.month));
		const newYear = (newMonth && (reading.month === this.startMonth))
			|| ((reading.month >= this.startMonth) && (reading.year > this.lastReadingYear.year));

		// set capabilities
		if (!newHour) {
			this.setCapability(this.ds.cmap.this_hour, valHour);
		} else {
			// new hour started
			this.log('new hour started');
			money.hour = 0;
			this.setCapability(this.ds.cmap.this_hour, 0);
			this.setCapability(this.ds.cmap.last_hour, valHour);
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			this.lastReadingHour = reading;
		}
		if (!newDay) {
			this.setCapability(this.ds.cmap.this_day, valDay);
		} else {
			// new day started
			this.log('new day started');
			money.day = 0;
			this.setCapability(this.ds.cmap.this_day, 0);
			this.setCapability(this.ds.cmap.last_day, valDay);
			await this.setStoreValue('lastReadingDay', reading);
			this.lastReadingDay = reading;
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
		}
		if (!newMonth) {
			this.setCapability(this.ds.cmap.this_month, valMonth);
		} else {
			// new month started
			this.log('new month started');
			money.month = 0;
			this.setCapability(this.ds.cmap.this_month, 0);
			this.setCapability(this.ds.cmap.last_month, valMonth);
			await this.setStoreValue('lastReadingMonth', reading);
			this.lastReadingMonth = reading;
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
		}
		if (!newYear) {
			this.setCapability(this.ds.cmap.this_year, valYear);
		} else {
			// new year started
			this.log('new year started');
			money.year = 0;
			this.setCapability(this.ds.cmap.this_year, 0);
			this.setCapability(this.ds.cmap.last_year, valYear);
			await this.setStoreValue('lastReadingYear', reading);
			this.lastReadingYear = reading;
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
		}

		// update money capabilities
		await this.updateMoneyCapabilities(money);
		if (!money.hour) {	// Update settings every hour
			await this.setSettings({ meter_money_this_day: this.lastMoney.day });
			await this.setSettings({ meter_money_this_month: this.lastMoney.month });
			await this.setSettings({ meter_money_this_year: this.lastMoney.year });
		}
		this.lastMoney = money;
		await this.setStoreValue('lastMoney', this.lastMoney);
	}

	async updateMoneyCapabilities(money) {
		// update money capabilities
		if (this.tariff !== this.getCapabilityValue('meter_tariff')) this.setCapability('meter_tariff', this.tariff);
		this.setCapability(this.ds.cmap.money_this_hour, money.hour);
		this.setCapability(this.ds.cmap.money_this_day, money.day);
		this.setCapability(this.ds.cmap.money_this_month, money.month);
		this.setCapability(this.ds.cmap.money_this_year, money.year);

	}

}

module.exports = SumMeterDevice;

/*
reading:
{ hour: 10,
	day: 8,
	month: 2,
	year: 2020,
	meterValue: 639.7536 }

money:
{ hour: 0.05500000000029104,
  day: 3.9405000000004655,
  month: 86.13475000000047,
  year: 86.13475000000047,
  meterValue: 33695.733}
*/
