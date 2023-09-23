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
const budget = require('../budget');

const setTimeoutPromise = util.promisify(setTimeout);

class SumMeterDevice extends Device {

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
			if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);
			if (this.meterDecimalsChanged) await this.migrateMeterOptions(this.settings.decimals_meter);
			this.migrated = true;
			await this.setAvailable().catch(this.error);

			// setup source for HOMEY-API devices with update listener
			if (!(this.settings.meter_via_flow || this.settings.homey_energy)) {
				this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.settings.homey_device_id, $cache: false }) // $timeout:15000
					.catch(this.error);
				// wait a bit for capabilitiesObj to fill?
				await setTimeoutPromise(3 * 1000);
				// check if source device exists
				const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
					&& Object.keys(this.sourceDevice.capabilitiesObj).length > 0 && (this.sourceDevice.available !== null);
				if (!sourceDeviceExists) throw Error(`Source device ${this.getName()} is missing. Retry in 10 minutes.`);
				// if (!this.sourceDevice || this.sourceDevice.ready !== true) throw Error(`Source device ${this.getName()} is not ready`);
			} else this.log(this.getName(), 'Skipping setup of source device. Meter update is done via flow or from Homey Energy');

			// restore device values
			await this.initDeviceValues();

			// init METER_VIA_FLOW device
			if (this.settings.meter_via_flow) await this.updateMeterFromFlow(null);
			// start listener for METER_VIA_WATT device
			else if (this.settings.use_measure_source) {
				this.log(`Warning! ${this.getName()} is not using a cumulative meter as source`);
				await this.addListeners();
				await this.updateMeterFromMeasure(null);
			// start polling HOMEY_ENERGY device and HOMEY-API devices set to polling
			} else if (this.settings.interval) this.startPolling(this.settings.interval);
			// start listener for HOMEY-API device not set to polling
			else {	// preferred realtime meter mode
				await this.addListeners();
				await this.pollMeter()
					.catch((error) => this.setUnavailable(error.message).catch(this.error));	// do immediate forced update
			}
			// this.log(`${this.getName()} has succesfully initialized.`);
			this.initReady = true;
		} catch (error) {
			this.initReady = false; // retry after 5 minutes
			this.error(error);
			// this.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
			this.setUnavailable(error.message).catch(this.error);
		}
	}

	async onUninit() {
		this.log(`Homey is killing ${this.getName()}`);
		this.stopPolling();
		this.destroyListeners();
		let delay = 1500;
		if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
		await setTimeoutPromise(delay);
	}

	// migrate stuff from old version < 5.0.2
	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);
			this.migrated = false;
			this.migrating = true;
			// console.log(this.getName(), this.settings, this.getStore());

			// check settings for homey energy
			if (this.settings.homey_energy) {
				if (!this.settings.interval) {
					await this.setSettings({ interval: 1 }).catch(this.error);
					this.settings.interval = 1;
				}
				if (this.settings.use_measure_source) {
					await this.setSettings({ use_measure_source: false }).catch(this.error);
					this.settings.use_measure_source = false;
				}
			}

			// check settings for for water and gas
			if (this.driver.id !== 'power' && this.settings.use_measure_source) {
				this.log(this.getName(), 'fixing wrong use_measure_source setting');
				await this.setSettings({ use_measure_source: false }).catch(this.error);
				this.settings.use_measure_source = false;
			}

			// store the capability states before migration
			const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
			const state = this[sym];
			// check and repair incorrect capability(order)
			let correctCaps = this.driver.ds.deviceCapabilities;
			// add meter_target_xxx distribution setting  versions >5.0.4
			if (this.getSettings().level < '5.0.0') {
				let distribution = 'NONE';
				if (this.driver.id === 'gas') distribution = 'gas_nl_2023';
				if (this.driver.id === 'water') distribution = 'linear';
				if (this.driver.id === 'power' && !(this.settings.meter_via_flow || this.settings.homey_energy)) {
					const sourceD = await this.homey.app.api.devices.getDevice({ id: this.settings.homey_device_id, $cache: false }) // $timeout:15000
						.catch(this.error);
					await setTimeoutPromise(3 * 1000); // wait a bit for capabilitiesObj to fill?
					// check if source device exists
					const sourceDeviceExists = sourceD && sourceD.capabilitiesObj;
					if (sourceDeviceExists) {
						if (sourceD.energyObj && sourceD.energyObj.cumulative) distribution = 'el_nl_2023';
					}
				}
				this.log(`Migrating budget target distribution for ${this.getName()} to ${distribution}`);
				await this.setSettings({ distribution }).catch(this.error);
				await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settles
			}
			// remove meter_target_this_xxx caps  versions >5.0.2
			if (this.getSettings().distribution === 'NONE') correctCaps = correctCaps.filter((cap) => !cap.includes('meter_target'));
			for (let index = 0; index < correctCaps.length; index += 1) {
				const caps = this.getCapabilities();
				const newCap = correctCaps[index];
				if (caps[index] !== newCap) {
					this.setUnavailable('Device is migrating. Please wait!').catch(this.error);
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
					this.currencyChanged = true;
				}
			}
			// if (this.currencyChanged) await setTimeoutPromise(70 * 1000);

			if (this.getSettings().level < '5.4.6') this.currencyChanged = true;

			// migrate to new budget setting > 5.3.0
			const budgetSetting = this.getSettings().budget;
			if (typeof budgetSetting === 'number') {
				this.log(this.getName(), 'migrating budget setting from number to string', budgetSetting);
				await this.setSettings({ budget: budgetSetting.toString() }).catch(this.error);
			}

			// convert tariff_via_flow to tariff_update_group <4.7.1
			if (this.getSettings().level < '4.7.1') {
				const group = this.getSettings().tariff_via_flow ? 1 : 0;
				this.log(`Migrating tariff group for ${this.getName()} to ${group}`);
				await this.setSettings({ tariff_update_group: group }).catch(this.error);
			}

			// set meter_power from store v3.6.0
			const lastMoney = await this.getStoreValue('lastMoney');
			if (lastMoney && lastMoney.meterValue) {
				this.log('Migrating meter value from v3.6.0 store');
				// restore the moved capabilities (min/max values)
				this.lastMinMax = await this.getStoreValue('lastMinMax');
				await this.minMaxReset(false, 'store migration');
				// set new meter_source capability
				await this.setCapabilityValue(this.ds.cmap.meter_source, lastMoney.meterValue);
				// set money values
				await this.setSettings({ meter_money_this_day: lastMoney.day }).catch(this.error);
				await this.setSettings({ meter_money_this_month: lastMoney.month }).catch(this.error);
				await this.setSettings({ meter_money_this_year: lastMoney.year }).catch(this.error);
				// await this.setCapabilityValue('meter_money_this_year', lastMoney.year);
				await this.unsetStoreValue('lastMoney');
			}

			// set new migrate level
			await this.setSettings({ level: this.homey.app.manifest.version }).catch(this.error);
			this.settings = await this.getSettings();
			this.migrating = false;
			Promise.resolve(true);
		} catch (error) {
			this.error('Migration failed', error);
			Promise.reject(error);
		}
	}

	async migrateCurrencyOptions(currency, decimals) {
		this.log('migrating money capability options');
		this.migrating = true;
		this.setUnavailable('Device is migrating. Please wait!').catch(this.error);

		// determine new units and decimals
		let curr = currency;
		let dec = decimals;
		let unit = 'kWh';
		if (!currency || currency === '') curr = '¤';
		if (!Number.isInteger(decimals)) dec = 2;
		if (this.driver.id !== 'power') unit = 'm³';

		const moneyOptions = {
			units: { en: curr },
			decimals: dec,
		};
		const tariffOptions = {
			units: { en: curr },
			decimals: 4,
		};
		const avgOptions = {
			units: { en: `${curr}/${unit}` },
			decimals: 4,
		};

		// migrate currency and decimals for money caps
		const moneyCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('money') && !name.includes('_avg'));
		for (let i = 0; i < moneyCaps.length; i += 1) {
			this.log('migrating money units and decimals', moneyCaps[i]);
			await this.setCapabilityOptions(moneyCaps[i], moneyOptions).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		// migrate currency and decimals for tariff
		this.log('migrating meter_tariff units and decimals');
		await this.setCapabilityOptions('meter_tariff', tariffOptions).catch(this.error);
		await setTimeoutPromise(2 * 1000);
		// migrate currency and decimals for avg tariff
		if (this.driver.id !== 'water') {
			this.log('migrating meter_money_this_month_avg units and decimals');
			await this.setCapabilityOptions('meter_money_this_month_avg', avgOptions).catch(this.error);
			await setTimeoutPromise(2 * 1000);

			this.log('migrating meter_money_this_year_avg units and decimals');
			await this.setCapabilityOptions('meter_money_this_year_avg', avgOptions).catch(this.error);
			await setTimeoutPromise(2 * 1000);

			try {
				const optsMoneyThisYearAvg = this.getCapabilityOptions('meter_money_this_year_avg');
				this.log('capability options migration ready', optsMoneyThisYearAvg);
			} catch (error) { this.error(`capability options migration has an error: ${error.message}`); }
		}
		this.currencyChanged = false;
		this.migrating = false;
	}

	async migrateMeterOptions(decimals) {
		this.log('migrating meter capability options');
		this.migrating = true;
		this.setUnavailable('Device is migrating. Please wait!').catch(this.error);

		// determine new units and decimals
		let dec = decimals;
		if (!Number.isInteger(decimals)) dec = 4;

		const optionsKWh = {
			units: { en: 'kWh' },
			decimals: dec,
		};
		const optionM3 = {
			units: { en: 'm³' },
			decimals: dec,
		};

		const meterKWhCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_kwh'));
		// options.units = { en: 'kWh' };
		for (let i = 0; i < meterKWhCaps.length; i += 1) {
			this.log('migrating decimals for', meterKWhCaps[i]);
			await this.setCapabilityOptions(meterKWhCaps[i], optionsKWh).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		if (this.hasCapability('meter_power')) {
			this.log('migrating decimals for meter_power');
			await this.setCapabilityOptions('meter_power', optionsKWh).catch(this.error);
		}
		const meterM3Caps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_m3'));
		for (let i = 0; i < meterM3Caps.length; i += 1) {
			this.log('migrating decimals for', meterM3Caps[i]);
			await this.setCapabilityOptions(meterM3Caps[i], optionM3).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		if (this.hasCapability('meter_gas')) {
			this.log('migrating decimals for meter_gas');
			await this.setCapabilityOptions('meter_gas', optionM3).catch(this.error);
		}
		if (this.hasCapability('meter_water')) {
			this.log('migrating decimals for meter_water');
			await this.setCapabilityOptions('meter_water', optionM3).catch(this.error);
		}
		this.meterDecimalsChanged = false;
		this.migrating = false;
		this.log('meter capability options migration ready');
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		this.stopPolling();
		this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!').catch(this.error);
		await setTimeoutPromise(dly); // .then(() => this.onInitDevice());
		this.onInitDevice().catch(this.error);
	}

	// this method is called when the Device is added
	async onAdded() {
		this.log(`Meter added as device: ${this.getName()}`);
		if (this.driver.id !== 'power') this.currencyChanged = true;
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
		if (!this.migrated) throw Error('device is not ready. Ignoring new settings!');
		this.log(`${this.getName()} device settings changed by user`, newSettings);

		if (this.lastReadingDay && this.lastReadingMonth && this.lastReadingYear) {
			const lastReadingDay = { ...this.lastReadingDay };
			const lastReadingMonth = { ...this.lastReadingMonth };
			const lastReadingYear = { ...this.lastReadingYear };
			if (changedKeys.includes('meter_day_start')) {
				lastReadingDay.meterValue = newSettings.meter_day_start;
				await this.setStoreValue('lastReadingDay', lastReadingDay);
			}
			if (changedKeys.includes('meter_month_start')) {
				lastReadingMonth.meterValue = newSettings.meter_month_start;
				await this.setStoreValue('lastReadingMonth', lastReadingMonth);
			}
			if (changedKeys.includes('meter_year_start')) {
				lastReadingYear.meterValue = newSettings.meter_year_start;
				await this.setStoreValue('lastReadingYear', lastReadingYear);
			}
		}

		if (this.meterMoney) {
			const money = { ...this.meterMoney };
			if (changedKeys.includes('meter_money_this_day')) {
				money.day = newSettings.meter_money_this_day;
			}
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
				// await this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth);
				// await this.setCapability('meter_money_this_year_avg', moneyThisMonth / meterThisMonth);
			}
		}

		if (this.lastReadingMonth && this.lastReadingYear) {
			if (changedKeys.includes('start_date')) {
				const now = new Date();
				const nowLocal = new Date(now.toLocaleString('en-GB', { timeZone: this.timeZone }));
				const thisMonth = nowLocal.getMonth();
				const thisYear = nowLocal.getFullYear();
				this.lastReadingMonth.month = thisMonth;
				this.lastReadingYear.year = thisYear;
			}
		}

		if (this.tariffHistory) {
			if (changedKeys.includes('tariff')) {
				this.tariffHistory.current = newSettings.tariff;
				await this.setStoreValue('tariffHistory', this.tariffHistory);
			}
		}

		if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
			this.currencyChanged = true;
		}

		if (changedKeys.includes('budget')) {
			if ((newSettings.distribution && newSettings.distribution === 'CUSTOM')
				|| (!newSettings.distribution && this.settings.distribution === 'CUSTOM')) {
				const d = newSettings.budget || this.getSettings().budget || '';
				const dist = d.split(';').map((month) => Number(month));
				const valid = (dist.length === 12) && dist.reduce((prev, cur) => prev && Number.isFinite(cur), true);
				if (!valid) throw Error('Custom budget does not have 12 number values');
			} else {
				const valid = Number.isFinite(Number(newSettings.budget));
				if (!valid) throw Error('Budget is not a valid number');
			}
		}

		if (changedKeys.includes('distribution')) {
			this.migrated = false;
		}

		if (changedKeys.includes('decimals_meter')) {
			this.meterDecimalsChanged = true;
		}

		this.restartDevice(1000).catch(this.error);
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

	stopPolling() {
		this.log(`Stop polling ${this.getName()}`);
		this.homey.clearInterval(this.intervalIdDevicePoll);
		// this.homey.clearTimeout(this.timeoutIdRestart);
	}

	startPolling(interval) {
		this.homey.clearInterval(this.intervalIdDevicePoll);
		this.log(`start polling ${this.getName()} @${interval} minutes interval`);
		this.pollMeter().catch((error) => {
			this.error(error);
			this.setUnavailable(error.message).catch(this.error);
			this.initReady = false; // restart within 5 minutes
		});
		this.intervalIdDevicePoll = this.homey.setInterval(async () => {
			try {
				await this.pollMeter();
			} catch (error) {
				this.error(error.message);
				this.setUnavailable('Polling failed. Will retry soon..').catch(this.error);
				this.initReady = false; // restart within 5 minutes
			}
		}, 1000 * 60 * interval);
	}

	async setCapability(capability, value) {
		if (this.hasCapability(capability) && value !== undefined) {
			this.setCapabilityValue(capability, value)
				.catch((error) => {
					this.error(error, capability, value);
				});
		}
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
		return { ...reading };
	}

	async initDeviceValues() {
		if (!this.available) this.setAvailable().catch(this.error);
		this.log(`${this.getName()} Restoring device values after init`);

		// init tariffHistory
		if (!this.tariffHistory) this.tariffHistory = await this.getStoreValue('tariffHistory');
		if (!this.tariffHistory) {
			this.tariffHistory = {
				previous: null,	// is still used just after newHour
				previousTm: null,
				current: this.settings.tariff,
				currentTm: new Date(), // time in UTC
			};
			await this.setStoreValue('tariffHistory', this.tariffHistory);
		}

		// init incoming meter queue
		if (!this.newReadings) this.newReadings = [];

		// init daily resetting source devices
		if (!this.dayStartCumVal) this.dayStartCumVal = this.settings.meter_day_start;
		if (!this.cumVal) this.cumVal = this.dayStartCumVal;
		if (!this.lastAbsVal) this.lastAbsVal = 0;

		// init this.startDay, this.startMonth and this.year
		let startDateString = this.settings.start_date;
		if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
		this.startDay = Number(startDateString.slice(0, 2));
		this.startMonth = Number(startDateString.slice(2, 4));
		if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
		if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
		this.startMonth -= 1; // January is month 0
		// let nowLocal = new Date();
		// nowLocal = new Date(nowLocal.toLocaleString('en-US', { timeZone: this.timeZone }));
		// this.year = nowLocal.getFullYear();

		// init this.budgets
		if (!this.budgets) this.budgets = this.getBudgets();

		// init this.lastReading
		if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
		if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
		if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
		if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

		// init this.lastMinMax
		if (!this.lastMinMax) this.lastMinMax = this.getStoreValue('lastMinMax');

		// PAIR init meter_power for use_measure_source
		const meterX = await this.getCapabilityValue(this.ds.cmap.meter_source);
		if ((this.settings.use_measure_source || this.settings.homey_energy) && typeof meterX !== 'number') {
			this.log('meter kWh is set to 0 after device pair');
			await this.setCapability(this.ds.cmap.meter_source, 0);
		}

		// init this.lastMeasure
		if (!this.lastMeasure) {
			this.lastMeasure = {
				value: await this.getCapabilityValue(this.ds.cmap.measure_source), // Can I restore measureTm from lastUpdated capabilityObj?
				measureTm: (this.lastMinMax && this.lastMinMax.reading) ? new Date(this.lastMinMax.reading.meterTm) : new Date(),
			};
			// PAIR init
			if (typeof this.lastMeasure.value !== 'number') this.lastMeasure.value = 0;
		}
		// assume 0 power when long time since last seen
		if ((new Date() - new Date(this.lastMeasure.measureTm)) > 300000) this.lastMeasure.value = 0;

		// init this.meterMoney
		if (!this.meterMoney) {
			this.meterMoney = {
				hour: await this.getCapabilityValue('meter_money_this_hour'),
				day: await this.getCapabilityValue('meter_money_this_day'),
				month: await this.getCapabilityValue('meter_money_this_month'),
				year: await this.getCapabilityValue('meter_money_this_year'),
				meterValue: await this.getCapabilityValue(this.ds.cmap.meter_source),	// current meter value.
				lastHour: await this.getCapabilityValue('meter_money_last_hour'),
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
			await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch(this.error);
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue }).catch(this.error);
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue }).catch(this.error);
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue }).catch(this.error);
		}
		// pair init Money
		if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
		// pair init minMax
		if (!this.lastMinMax) {	// pair init
			this.lastMinMax = {
				reading,
				wattMax: null,
				lpmMax: null,
				wattMin: null,
				lpmMin: null,
				reset: null,
			};
			await this.minMaxReset(true, 'pairInit');
		}
		this.initReady = true;
	}

	// update the tariff from flow or DAP
	async updateTariffHistory(tariff, currentTm) {
		try {
			if (!this.migrated || !this.tariffHistory) {
				this.log('device is not ready. Ignoring new tariff!');
				return;
			}
			const tariffHistory = {
				previous: this.tariffHistory.current,
				previousTm: this.tariffHistory.currentTm,
				current: tariff,
				currentTm,
			};
			this.tariffHistory = tariffHistory;
			this.setCapability('meter_tariff', tariff);
			this.setSettings({ tariff }).catch(this.error);
			this.setStoreValue('tariffHistory', tariffHistory);
		} catch (error) {
			this.error(error);
		}
	}

	async handleUpdateMeter(reading) {
		try {
			const periods = this.getPeriods(reading);	// check for new hour/day/month/year
			await this.updateMeters(reading, periods);
			await this.updateTargets(periods);
			await this.updateMoney(reading, periods);
			await this.updateAvgMoney(periods);
			await this.updateMeasureMinMax(reading, periods);
		} catch (error) {
			this.error(error);
		}
	}

	async updateMeter(val) { // , pollTm) { // pollTm is lastUpdated when using pollMethod
		try {
			if (typeof val !== 'number') return;
			if (!this.migrated || this.currencyChanged) return;
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
					await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue }).catch(this.error);
					this.cumVal += absVal;
				} else {
					this.cumVal = this.dayStartCumVal + absVal;
				}
				value = this.cumVal;
			}
			// create a readingObject from value
			const reading = await this.getReadingObject(value);
			if (!this.initReady || !this.lastReadingYear) await this.initFirstReading(reading); // after app start
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

	async updateMeterFromFlow(val) {
		if (!this.migrated || this.currencyChanged) return;
		let value = val;
		if (value === null) { // poll requested
			value = await this.getCapabilityValue(this.ds.cmap.meter_source);
			if (value === null) return;
		}
		await this.updateMeter(value);
	}

	// takes Watt, creates kWh metervalue
	async updateMeterFromMeasure(val) {
		if (!this.migrated || this.currencyChanged) return;
		const measureTm = new Date();
		let value = val;
		if (value === null && !this.settings.homey_energy) { // poll requested or app init
			// get value from source device
			if (this.sourceDevice && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_power) {
				value = this.sourceDevice.capabilitiesObj.measure_power.value;
			}
			// if (typeof value !== 'number') value = await this.getCapabilityValue(this.ds.cmap.measure_source);
		}
		if (typeof value !== 'number') return;
		const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);
		// only update on >2 watt changes, or more then 2 minutes past, or value = 0
		// if ((Math.abs(value - this.lastMeasure.value) > 2) || value === 0 || deltaTm > 120000) {
		const lastMeterValue = await this.getCapabilityValue(this.ds.cmap.meter_source);
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
		this.lastMeasure = {
			value,
			measureTm,
		};
		await this.updateMeter(meter); // what to do with timestamp???
		// }
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

	getBudgets() {
		if (!this.settings.distribution || this.settings.distribution === 'NONE') return null;

		const date = new Date();
		const dateLocal = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));
		const yearLocal = dateLocal.getFullYear();
		const startOfMonth = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));
		startOfMonth.setDate(this.startDay); // first day of this month
		const soyDayNr = budget.getDayOfYear(new Date(yearLocal, this.startMonth, this.startDay)); // start of this year 1 - 366
		const somDayNr = budget.getDayOfYear(startOfMonth); // start of this month 1 - 366
		const nowDayNr = budget.getDayOfYear(dateLocal); // start of this day 1 - 366

		const monthToDate = budget.getBudget(this.settings.distribution, this.settings.budget, nowDayNr, somDayNr);
		const yearToDate = budget.getBudget(this.settings.distribution, this.settings.budget, nowDayNr, soyDayNr);
		const budgets = { monthToDate, yearToDate };
		return budgets;
	}

	async minMaxReset(reset, source) {
		if (!this.lastMinMax || !this.lastMinMax.reading) {
			this.error('minMax could not be reset (nothing to reset yet)');
			return;
		}
		if (reset) {
			this.log(`Resetting Min/Max via ${source}`);
			this.lastMinMax = {
				reading: { ...this.lastMinMax.reading }, // contains last meter reading object used for min/max
				wattMax: null,
				lpmMax: null,
				wattMin: null,
				lpmMin: null,
				reset: new Date(), // time at wich the min/max was reset
			};
		}
		const date = this.lastMinMax.reset.toLocaleString('nl-NL', {
			timeZone: this.timeZone, hour12: false, day: '2-digit', month: '2-digit',
		});
		const time = this.lastMinMax.reset.toLocaleString('nl-NL', {
			timeZone: this.timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
		});
		this.setCapability('measure_watt_max', this.lastMinMax.wattMax);
		this.setCapability('measure_lpm_max', this.lastMinMax.lpmMax);
		this.setCapability('measure_watt_min', this.lastMinMax.wattMin);
		this.setCapability('measure_lpm_min', this.lastMinMax.lpmMin);
		this.setCapability('last_minmax_reset', `${date} ${time}`);
		await this.setStoreValue('lastMinMax', this.lastMinMax);
	}

	async updateMeters({ ...reading }, { ...periods }) {
		this.setCapability(this.ds.cmap.meter_source, reading.meterValue);
		// temp copy this.lastReadingX
		let lastReadingHour = { ...this.lastReadingHour };
		let lastReadingDay = { ...this.lastReadingDay };
		let lastReadingMonth = { ...this.lastReadingMonth };
		let lastReadingYear = { ...this.lastReadingYear };
		// calculate meters
		let valHour = reading.meterValue - lastReadingHour.meterValue;
		let valDay = reading.meterValue - lastReadingDay.meterValue;
		let valMonth = reading.meterValue - lastReadingMonth.meterValue;
		let valYear = reading.meterValue - lastReadingYear.meterValue;
		// set capabilities
		if (periods.newHour) {
			// new hour started
			this.setCapability(this.ds.cmap.last_hour, valHour);
			lastReadingHour = reading;
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch(this.error);
			valHour = 0;
		}
		if (periods.newDay) {
			// new day started
			this.setCapability(this.ds.cmap.last_day, valDay);
			lastReadingDay = reading;
			await this.setStoreValue('lastReadingDay', reading);
			await this.setSettings({ meter_day_start: lastReadingDay.meterValue }).catch(this.error);
			valDay = 0;
		}
		if (periods.newMonth) {
			// new month started
			this.setCapability(this.ds.cmap.last_month, valMonth);
			lastReadingMonth = reading;
			await this.setStoreValue('lastReadingMonth', reading);
			await this.setSettings({ meter_month_start: lastReadingMonth.meterValue }).catch(this.error);
			valMonth = 0;
		}
		if (periods.newYear) {
			// new year started
			this.setCapability(this.ds.cmap.last_year, valYear);
			lastReadingYear = reading;
			await this.setStoreValue('lastReadingYear', reading);
			await this.setSettings({ meter_year_start: lastReadingYear.meterValue }).catch(this.error);
			valYear = 0;
		}
		// console.log(this.getName(), valHour, valDay, valMonth, valYear);
		this.setCapability(this.ds.cmap.this_hour, valHour);
		this.setCapability(this.ds.cmap.this_day, valDay);
		this.setCapability(this.ds.cmap.this_month, valMonth);
		this.setCapability(this.ds.cmap.this_year, valYear);
		// store this.lastReadingX
		if (periods.newHour) this.lastReadingHour = lastReadingHour;
		if (periods.newDay) this.lastReadingDay = lastReadingDay;
		if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
		if (periods.newYear) this.lastReadingYear = lastReadingYear;
	}

	async updateTargets({ ...periods }) {
		// update tariff capability
		if (!this.settings.distribution || this.settings.distribution === 'NONE') return;
		if (periods.newDay) this.budgets = this.getBudgets();
		if (this.budgets && this.budgets.yearToDate) {
			const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_year) / this.budgets.yearToDate);
			this.setCapability('meter_target_year_to_date', onTarget);
		}
		if (this.budgets && this.budgets.monthToDate) {
			const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_month) / this.budgets.monthToDate);
			this.setCapability('meter_target_month_to_date', onTarget);
		}
	}

	async updateMoney({ ...reading }, { ...periods }) {
		let tariff = this.tariffHistory.current;
		// update tariff capability
		if (tariff !== await this.getCapabilityValue('meter_tariff')) this.setCapability('meter_tariff', tariff);
		// use previous hour tariff just after newHour and previous tariff is less then an hour old
		if (periods.newHour && this.tariffHistory && this.tariffHistory.previousTm
			&& (new Date(reading.meterTm) - new Date(this.tariffHistory.previousTm))
			< (61 + this.settings.wait_for_update) * 60 * 1000) tariff = this.tariffHistory.previous;
		// calculate money
		const deltaMoney = (reading.meterValue - this.meterMoney.meterValue) * tariff;
		const meterMoney = {
			hour: this.meterMoney.hour + deltaMoney,
			day: this.meterMoney.day + deltaMoney,
			month: this.meterMoney.month + deltaMoney,
			year: this.meterMoney.year + deltaMoney,
			meterValue: reading.meterValue,
			lastHour: this.meterMoney.lastHour,
			lastDay: this.meterMoney.lastDay,
			lastMonth: this.meterMoney.lastMonth,
			lastYear: this.meterMoney.lastYear,
		};
		let fixedMarkup = 0;
		if (periods.newHour) {
			// new hour started
			meterMoney.lastHour = meterMoney.hour;
			meterMoney.hour = 0;
			fixedMarkup += this.getSettings().markup_hour;
			await this.setCapability('meter_money_last_hour', meterMoney.lastHour);
			await this.setSettings({ meter_money_last_hour: meterMoney.lastHour }).catch(this.error);
		}
		if (periods.newDay) {
			// new day started
			meterMoney.lastDay = meterMoney.day;
			meterMoney.day = 0;
			fixedMarkup += this.getSettings().markup_day;
			await this.setCapability('meter_money_last_day', meterMoney.lastDay);
			await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch(this.error);
		}
		if (periods.newMonth) {
			// new month started
			meterMoney.lastMonth = meterMoney.month;
			meterMoney.month = 0;
			fixedMarkup += this.getSettings().markup_month;
			await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
			await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch(this.error);
		}
		if (periods.newYear) {
			// new year started
			meterMoney.lastYear = meterMoney.year;
			meterMoney.year = 0;
			await this.setCapability('meter_money_last_year', meterMoney.lastYear);
			await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch(this.error);
		}
		// add fixed markups
		meterMoney.hour += fixedMarkup;
		meterMoney.day += fixedMarkup;
		meterMoney.month += fixedMarkup;
		meterMoney.year += fixedMarkup;
		// update money_this_x capabilities
		await this.setCapability('meter_money_this_hour', meterMoney.hour);
		await this.setCapability('meter_money_this_day', meterMoney.day);
		await this.setCapability('meter_money_this_month', meterMoney.month);
		await this.setCapability('meter_money_this_year', meterMoney.year);
		this.meterMoney = meterMoney;
		// Update settings every hour
		if (periods.newHour) {
			await this.setSettings({ meter_money_this_day: meterMoney.day }).catch(this.error);
			await this.setSettings({ meter_money_this_month: meterMoney.month }).catch(this.error);
			await this.setSettings({ meter_money_this_year: meterMoney.year }).catch(this.error);
		}
	}

	async updateAvgMoney() {
		// update avg money / kWh_m3
		const moneyThisMonth = this.meterMoney.month;
		const meterThisMonth = await this.getCapabilityValue(this.ds.cmap.this_month);
		if (meterThisMonth) this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth);

		const moneyThisYear = this.meterMoney.year;
		const meterThisYear = await this.getCapabilityValue(this.ds.cmap.this_year);
		if (meterThisYear) this.setCapability('meter_money_this_year_avg', moneyThisYear / meterThisYear);
	}

	async updateMeasureMinMax({ ...reading }, { ...periods }) {
		// reset min/max based on device settings
		if ((periods.newHour && this.settings.min_max_reset === 'hour') || (periods.newDay && this.settings.min_max_reset === 'day')
			|| (periods.newMonth && this.settings.min_max_reset === 'month')
			|| (periods.newYear && this.settings.min_max_reset === 'year')) {
			await this.minMaxReset(true, 'device settings');
		}
		// minimal 2 minutes avg needed
		const deltaTm = new Date(reading.meterTm) - new Date(this.lastMinMax.reading.meterTm);
		const deltaMeter = reading.meterValue - this.lastMinMax.reading.meterValue;
		if (deltaTm < 119000) return;
		// calculate current avg use
		const measurePowerAvg = Math.round((3600000000 / deltaTm) * deltaMeter); // delta kWh > watt
		const measureWaterAvg = Math.round((deltaMeter / deltaTm) * 600000000) / 10; // delta m3 > liter/min
		const measureValue = this.driver.id === 'power' ? measurePowerAvg : measureWaterAvg;
		this.setCapability(this.ds.cmap.measure_source, measureValue);
		// check for new max/min values
		const {
			wattMax, lpmMax, wattMin, lpmMin,
		} = this.lastMinMax;
		if (wattMax === null || measurePowerAvg > wattMax) this.lastMinMax.wattMax = measurePowerAvg;
		if (lpmMax === null || measureWaterAvg > lpmMax) this.lastMinMax.lpmMax = measureWaterAvg;
		if (wattMin === null || measurePowerAvg < wattMin) this.lastMinMax.wattMin = measurePowerAvg;
		if (lpmMin === null || measureWaterAvg < lpmMin) this.lastMinMax.lpmMin = measureWaterAvg;
		this.lastMinMax.reading = reading;
		// update min/max capabilities
		if (this.minMaxInitReady) { // skip first interval after app start NEEDED BECAUSE OF POLLING NOT KNOWING CORRECT TIMESTAMP!!!
			this.setCapability('measure_watt_max', this.lastMinMax.wattMax);
			this.setCapability('measure_lpm_max', this.lastMinMax.lpmMax);
			this.setCapability('measure_watt_min', this.lastMinMax.wattMin);
			this.setCapability('measure_lpm_min', this.lastMinMax.lpmMin);
		} else this.log('Skipping first min/max interval for', this.getName());
		this.minMaxInitReady = true;
		await this.setStoreValue('lastMinMax', this.lastMinMax);
	}

}

module.exports = SumMeterDevice;

/*
reading: {	// not stored
	hour: 16,
	day: 27,
	month: 0,
	year: 2022,
	meterValue: 85.363,
	meterTm: 2022-01-27T15:22:10.109Z
},

this.meterMoney = {	// not stored
	hour: 0.05500000000029104,
	day: 3.9405000000004655,
	month: 86.13475000000047,
	year: 86.13475000000047,
	meterValue: 33695.733	// current meter value.
	lastHour: 0,
	lastDay: 0,
	lastMonth: 0,
	lastYear: 0,
};

this.lastReadingHour = reading; // at beginning of hour
this.lastReadingDay = reading;	// at beginning of day
this.lastReadingMonth = reading;	// at beginning of month
this.lastReadingYear = reading;	// at beginning of year

this.lastMeasure = {	// last averaged measure (watt)
	value: watt,
	measureTm: measureTm,
};

this.lastMinMax = {
  reading: {		// meter reading at last minMax averaging
    hour: 16,
    day: 27,
    month: 0,
    year: 2022,
    meterValue: 85.363,
    meterTm: 2022-01-27T15:22:10.109Z
  },
  wattMax: 167,		// also available as capability. So why store it????
  lpmMax: 2.8,		// also available as capability. So why store it????
  wattMin: 0,		// also available as capability. So why store it????
  lpmMin: 0,		// also available as capability. So why store it????
  reset: 2022-01-27T13:39:49.551Z	// reset time of minMax period
}

*/
