/* eslint-disable no-await-in-loop */
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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { Device } = require('homey');
const util = require('util');
const tradeStrategy = require('../hedge_strategy');

const setTimeoutPromise = util.promisify(setTimeout);

class batDevice extends Device {

	// this method is called when the Device is inited
	async onInitDevice() {
		try {
			// init some stuff
			this.restarting = false;
			// this.initReady = false;
			this.destroyListeners();
			this.timeZone = this.homey.clock.getTimezone();
			this.settings = await this.getSettings();

			if (!this.migrated) await this.migrate();
			this.migrated = true;
			await this.setAvailable();

			// restore device values
			await this.initDeviceValues();

			// start listeners
			await this.addListeners();

			// poll first values
			await this.poll();
		} catch (error) {
			this.error(error);
			this.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
			this.setUnavailable(error.message).catch(this.error);
		}
	}

	// migrate stuff from old version
	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);
			this.migrated = false;

			// store the capability states before migration
			const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
			const state = this[sym];
			// check and repair incorrect capability(order)
			const correctCaps = this.driver.ds.deviceCapabilities;

			for (let index = 0; index < correctCaps.length; index += 1) {
				const caps = this.getCapabilities();
				const newCap = correctCaps[index];
				if (caps[index] !== newCap) {
					this.setUnavailable('Device is migrating. Please wait!');
					// remove all caps from here
					for (let i = index; i < caps.length; i += 1) {
						this.log(`removing capability ${caps[i]} for ${this.getName()}`);
						await this.removeCapability(caps[i]).catch(this.error);
						await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
					}
					// add the new cap
					this.log(`adding capability ${newCap} for ${this.getName()}`);
					await this.addCapability(newCap).catch(this.error);
					// restore capability state
					if (state[newCap] !== undefined) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
					else this.log(`${this.getName()} no value to restore for new capability ${newCap}, ${state[newCap]}!`);
					await this.setCapability(newCap, state[newCap]);
					await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
				}
			}

			// set new migrate level
			await this.setSettings({ level: this.homey.app.manifest.version });
			this.settings = await this.getSettings();
			Promise.resolve(true);
		} catch (error) {
			this.error('Migration failed', error);
			Promise.reject(error);
		}
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!');
		await setTimeoutPromise(dly); // .then(() => this.onInitDevice());
		this.onInitDevice();
	}

	async onUninit() {
		this.log(`Homey is killing ${this.getName()}`);
		this.destroyListeners();
		let delay = 1500;
		if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
		await setTimeoutPromise(delay);
	}

	// this method is called when the Device is added
	async onAdded() {
		this.log(`Meter added as device: ${this.getName()}`);
	}

	// this method is called when the Device is deleted
	onDeleted() {
		this.destroyListeners();
		this.log(`Deleted as device: ${this.getName()}`);
	}

	onRenamed(name) {
		this.log(`${this.getName()} was renamed to: ${name}`);
	}

	// this method is called when the user has changed the device's settings in Homey.
	async onSettings({ newSettings, changedKeys }) { // , oldSettings, changedKeys) {
		if (!this.migrated) throw Error('device is not ready. Ignoring new settings!');
		this.log(`${this.getName()} device settings changed by user`, newSettings);

		if (this.meterMoney) {
			const money = { ...this.meterMoney };
			if (changedKeys.includes('meter_money_this_month')) {
				money.month = newSettings.meter_money_this_month;
			}
			if (changedKeys.includes('meter_money_this_year')) {
				money.year = newSettings.meter_money_this_year;
			}
			if (changedKeys.toString().includes('meter_money_last')) {
				money.lastDay = newSettings.meter_money_last_day;
				money.lastMonth = newSettings.meter_money_last_month;
				money.lastYear = newSettings.meter_money_last_year;
			}
			if (changedKeys.toString().includes('meter_money_')) {
				this.meterMoney = money;
				await this.setCapability('meter_money_last_day', money.lastDay);
				await this.setCapability('meter_money_last_month', money.lastMonth);
				await this.setCapability('meter_money_last_year', money.lastYear);
				await this.setCapability('meter_money_this_day', money.day);
				await this.setCapability('meter_money_this_month', money.month);
				await this.setCapability('meter_money_this_year', money.year);
			}
		}
		this.restartDevice(1000);
	}

	destroyListeners() {
		if (this.capabilityInstances && Object.entries(this.capabilityInstances).length > 0) {
			Object.entries(this.capabilityInstances).forEach((entry) => {
				this.log(`Destroying capability listener ${entry[0]}`);
				entry[1].destroy();
			});
		}
		this.capabilityInstances = {};
	}

	async setCapability(capability, value) {
		if (this.hasCapability(capability) && value !== undefined) {
			this.setCapabilityValue(capability, value)
				.catch((error) => {
					this.error(error, capability, value);
				});
		}
	}

	// EXECUTORS FOR CONDITION FLOWS AND TRIGGERS
	async priceBattBestTrade(args) {
		await setTimeoutPromise(3000); // wait 3 seconds for new hourly prices to be taken in
		if (!this.pricesNextHours) throw Error('no prices available');
		const chargePower = (this.getSettings().chargePower - this.getSettings().ownPowerOn) * (1 - this.getSettings().chargeLoss / 100);
		const dischargePower = (this.getSettings().dischargePower - this.getSettings().ownPowerOn) * (1 - this.getSettings().dischargeLoss / 100);
		const options = {
			prices: this.pricesNextHours,
			minPriceDelta: args.minPriceDelta,
			soc: this.soc,
			batCapacity: this.getSettings().batCapacity,
			chargePower,
			dischargePower,
		};
		const strat = tradeStrategy.getStrategy(options);
		return strat === Number(args.strat);
	}

	async getReadingObject(value) {
		const date = new Date(); // IF value has not changed, it must be a poll ,meaning date is unchanged?
		const dateLocal = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));
		const reading = {
			hour: dateLocal.getHours(),
			day: dateLocal.getDate(),
			month: dateLocal.getMonth(),
			year: dateLocal.getFullYear(),
			meterValue: value,
			meterTm: date,
		};
		return reading;
	}

	async initDeviceValues() {
		if (!this.available) this.setAvailable().catch(this.error);
		this.log(`${this.getName()} Restoring device values after init`);

		// init pricesNextHours
		if (!this.pricesNextHours) this.pricesNextHours = await this.getStoreValue('pricesNextHours');
		if (!this.pricesNextHours) {
			this.pricesNextHours = [0.25];
			await this.setStoreValue('pricesNextHours', this.pricesNextHours);
		}

		// init incoming meter queue
		this.newReadings = [];

		// init this.startDay, this.startMonth and this.year
		let startDateString = this.settings.start_date;
		if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
		this.startDay = Number(startDateString.slice(0, 2));
		this.startMonth = Number(startDateString.slice(2, 4));
		if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
		if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
		this.startMonth -= 1; // January is month 0

		// init this.lastReading
		this.lastReadingHour = await this.getStoreValue('lastReadingHour');
		this.lastReadingDay = await this.getStoreValue('lastReadingDay');
		this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
		this.lastReadingYear = await this.getStoreValue('lastReadingYear');

		// PAIR init meter_power_hidden for use_measure_source
		const meterX = await this.getCapabilityValue('meter_power_hidden');
		if (typeof meterX !== 'number') {
			this.log('meter kWh is set to 0 after device pair');
			await this.setCapability('meter_power_hidden', 0);
		}

		// init this.lastMeasure
		if (!this.lastMeasure) {
			this.lastMeasure = {
				value: 0,
				measureTm: new Date(),
			};
		}

		// init this.meterMoney
		if (!this.meterMoney) {
			this.meterMoney = {
				day: await this.getCapabilityValue('meter_money_this_day'),
				month: await this.getCapabilityValue('meter_money_this_month'),
				year: await this.getCapabilityValue('meter_money_this_year'),
				meterValue: await this.getCapabilityValue('meter_power_hidden'),	// current meter value.
				lastDay: await this.getCapabilityValue('meter_money_last_day'),
				lastMonth: await this.getCapabilityValue('meter_money_last_month'),
				lastYear: await this.getCapabilityValue('meter_money_last_year'),
			};
		}
	}

	// init some stuff when first reading comes in
	async initFirstReading({ ...reading }) {
		// check pair init
		const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
		if (pairInit) {
			this.log(`${this.getName()} Setting values after pair init`);
			await this.setStoreValue('lastReadingHour', reading);
			this.lastReadingHour = reading;
			const dayStart = this.settings.homey_device_daily_reset ? this.getReadingObject(0) : reading;
			await this.setStoreValue('lastReadingDay', dayStart);
			this.lastReadingDay = dayStart;
			await this.setStoreValue('lastReadingMonth', reading);
			this.lastReadingMonth = reading;
			await this.setStoreValue('lastReadingYear', reading);
			this.lastReadingYear = reading;
			// set meter start in device settings
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
		}
		// pair init Money
		if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
		this.initReady = true;
	}

	// update the prices from DAP
	async updatePrices(pricesNextHours) {
		try {
			if (!pricesNextHours || !pricesNextHours[0]) return;
			this.pricesNextHours = pricesNextHours;
			this.setCapability('meter_tariff', pricesNextHours[0]);
			this.setStoreValue('pricesNextHours', pricesNextHours);
		} catch (error) {
			this.error(error);
		}
	}

	async handleUpdateMeter(reading) {
		try {
			const periods = this.getPeriods(reading);	// check for new hour/day/month/year
			await this.updateMeters(reading, periods);
			await this.updateMoney(reading, periods);
		} catch (error) {
			this.error(error);
		}
	}

	updateValue(val, cap) {
		try {
			if (cap === 'chargeMode') return;
			if (cap === 'soc') {
				this.soc = val;
				const storedkWh = val * (this.getSettings().batCapacity / 100);
				this.setCapability('meter_kwh_stored', storedkWh);
			}
			if (cap === 'productionPower') {
				this.updateMeterFromMeasure(val);
			}
			if (cap === 'usagePower') {
				this.updateMeterFromMeasure(-val);
			}
		} catch (error) {
			this.error(error);
		}
	}

	async updateMeter(val) { // , pollTm) { // pollTm is lastUpdated when using pollMethod
		try {
			if (typeof val !== 'number') return;
			if (!this.migrated || this.currencyChanged) return;
			const value = val;
			// create a readingObject from value
			const reading = await this.getReadingObject(value);
			if (!this.initReady) await this.initFirstReading(reading); // after app start
			// Put values in queue
			if (!this.newReadings) this.newReadings = [];
			this.newReadings.push(reading);
			while (this.newReadings.length > 0) {
				const newReading = this.newReadings.shift();
				await this.handleUpdateMeter(newReading);
			}
		} catch (error) {
			this.error(error);
		}
	}

	// takes Watt, creates kWh metervalue
	async updateMeterFromMeasure(val) {
		if (!this.migrated) return;
		const measureTm = new Date();
		let value = val;
		// apply power corrections
		if (val > 0) {	// discharging
			value -= this.getSettings().ownPowerOn; // substract own usage. default 35
			value *= (1 - this.getSettings().dischargeLoss / 100); // substract default 7.7%
		}
		if (val < 0) {	// charging
			value -= this.getSettings().ownPowerOn; // substract own usage. default 35
			value /= (1 - this.getSettings().chargeLoss / 100); // add default 9.7%
		}
		if (val === 0) { // standby
			value -= this.getSettings().ownPowerStandby; // substract standby usage. default 2.5
		}

		if (typeof value !== 'number') return;
		const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);
		// only update on >2 watt changes, or more then 2 minutes past, or value = 0
		// if ((Math.abs(value - this.lastMeasure.value) > 2) || value === 0 || deltaTm > 120000) {
		const lastMeterValue = await this.getCapabilityValue('meter_power_hidden');
		let lastChargingMeterValue = await this.getCapabilityValue('meter_kwh_charging');
		let lastDischargingMeterValue = await this.getCapabilityValue('meter_kwh_discharging');
		if (typeof lastMeterValue !== 'number') {
			this.error('lastMeterValue is NaN, WTF');
			return;
		}
		if (typeof deltaTm !== 'number' || deltaTm === 0) {
			this.error('deltaTm is NaN, WTF');
			return;
		}
		const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
		const meter = lastMeterValue + deltaMeter;
		if (deltaMeter > 0) {
			lastDischargingMeterValue += deltaMeter;
			this.setCapability('meter_kwh_discharging', lastDischargingMeterValue);
		} else {
			lastChargingMeterValue -= deltaMeter;
			this.setCapability('meter_kwh_charging', lastChargingMeterValue);
		}
		this.setCapability('measure_watt_avg', value);
		this.lastMeasure = {
			value,
			measureTm,
		};
		await this.updateMeter(meter); // what to do with timestamp???
	}

	getPeriods(reading) { // MUST BE RUN BEFORE UPDATEMETERS!!!
		// check for new hour, day, month year
		const newHour = reading.hour !== this.lastReadingHour.hour;
		const newDay = (reading.day !== this.lastReadingDay.day);
		const newMonth = (newDay && (reading.day === this.startDay))
			|| ((reading.day >= this.startDay) && (reading.month > this.lastReadingMonth.month));
		const newYear = (newMonth && (reading.month === this.startMonth))
			|| ((reading.month >= this.startMonth) && (reading.year > this.lastReadingYear.year));
		if (newHour) this.log('new hour started', this.getName());
		if (newDay) this.log('new day started', this.getName());
		if (newMonth) this.log('new month started', this.getName());
		if (newYear) this.log('(Happy!) new year started', this.getName());
		const periods = {
			newHour, newDay, newMonth, newYear,
		};
		return periods;
	}

	async updateMeters({ ...reading }, { ...periods }) {
		this.setCapability('meter_power_hidden', reading.meterValue);
		// temp copy this.lastReadingX
		let lastReadingHour = { ...this.lastReadingHour };
		let lastReadingDay = { ...this.lastReadingDay };
		let lastReadingMonth = { ...this.lastReadingMonth };
		let lastReadingYear = { ...this.lastReadingYear };
		// set capabilities
		if (periods.newHour) {
			// new hour started
			// this.setCapability(this.ds.cmap.last_hour, valHour);
			lastReadingHour = reading;
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
		}
		if (periods.newDay) {
			// new day started
			lastReadingDay = reading;
			await this.setStoreValue('lastReadingDay', reading);
		}
		if (periods.newMonth) {
			// new month started
			lastReadingMonth = reading;
			await this.setStoreValue('lastReadingMonth', reading);
		}
		if (periods.newYear) {
			// new year started
			lastReadingYear = reading;
			await this.setStoreValue('lastReadingYear', reading);
		}
		// store this.lastReadingX
		if (periods.newHour) this.lastReadingHour = lastReadingHour;
		if (periods.newDay) this.lastReadingDay = lastReadingDay;
		if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
		if (periods.newYear) this.lastReadingYear = lastReadingYear;
	}

	async updateMoney({ ...reading }, { ...periods }) {
		const tariff = this.pricesNextHours[0];
		// update tariff capability
		if (tariff !== await this.getCapabilityValue('meter_tariff')) this.setCapability('meter_tariff', tariff);
		// calculate money
		const deltaMoney = (reading.meterValue - this.meterMoney.meterValue) * tariff;
		const meterMoney = {
			day: this.meterMoney.day + deltaMoney,
			month: this.meterMoney.month + deltaMoney,
			year: this.meterMoney.year + deltaMoney,
			meterValue: reading.meterValue,
			lastDay: this.meterMoney.lastDay,
			lastMonth: this.meterMoney.lastMonth,
			lastYear: this.meterMoney.lastYear,
		};
		if (periods.newDay) {
			// new day started
			meterMoney.lastDay = meterMoney.day;
			meterMoney.day = 0;
			await this.setCapability('meter_money_last_day', meterMoney.lastDay);
			await this.setSettings({ meter_money_last_day: meterMoney.lastDay });
		}
		if (periods.newMonth) {
			// new month started
			meterMoney.lastMonth = meterMoney.month;
			meterMoney.month = 0;
			await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
			await this.setSettings({ meter_money_last_month: meterMoney.lastMonth });
		}
		if (periods.newYear) {
			// new year started
			meterMoney.lastYear = meterMoney.year;
			meterMoney.year = 0;
			await this.setCapability('meter_money_last_year', meterMoney.lastYear);
			await this.setSettings({ meter_money_last_year: meterMoney.lastYear });
		}
		// update money_this_x capabilities
		await this.setCapability('meter_money_this_day', meterMoney.day);
		await this.setCapability('meter_money_this_month', meterMoney.month);
		await this.setCapability('meter_money_this_year', meterMoney.year);
		this.meterMoney = meterMoney;
		// Update settings every hour
		if (periods.newHour) {
			await this.setSettings({ meter_money_this_day: meterMoney.day });
			await this.setSettings({ meter_money_this_month: meterMoney.month });
			await this.setSettings({ meter_money_this_year: meterMoney.year });
		}
	}

}

module.exports = batDevice;
