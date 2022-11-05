/* eslint-disable no-await-in-loop */
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
			await this.destroyListeners();
			this.timeZone = this.homey.clock.getTimezone();
			this.settings = await this.getSettings();

			if (!this.migrated) await this.migrate();
			if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);
			if (this.meterDecimalsChanged) await this.migrateMeterOptions(this.settings.decimals_meter);

			// check settings for homey energy device
			if (this.settings.homey_energy) {
				if (!this.settings.interval) {
					this.setSettings({ interval: 1 });
					this.settings.interval = 1;
				}
				if (this.settings.use_measure_source) {
					this.setSettings({ use_measure_source: false });
					this.settings.use_measure_source = false;
				}
			}

			// setup source device
			if (!(this.settings.meter_via_flow || this.settings.homey_energy)) {
				this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.settings.homey_device_id, $cache: false, $timeout: 25000 })
					.catch(this.error);
				// check if source device exists
				const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj; // && (this.sourceDevice.available !== null);
				if (!sourceDeviceExists) throw Error(`Source device ${this.getName()} is missing. Retry in 10 minutes.`);
				// check if source device is ready
				if (!this.sourceDevice) throw Error(`Source device ${this.getName()} is not ready. Retry in 10 minutes.`);
				// if (!this.sourceDevice || this.sourceDevice.ready !== true) throw Error(`Source device ${this.getName()} is not ready`);
			} else this.log(this.getName(), 'Skipping setup of source device. Meter update is done via flow or from Homey Energy');

			// restore device values
			await this.initDeviceValues();

			// start listeners or polling mode
			if (this.settings.meter_via_flow) await this.updateMeterFromFlow(null);
			else if (this.settings.use_measure_source) {
				this.log(`Warning! ${this.getName()} is not using a cumulative meter as source`);
				await this.addListeners();
				await this.updateMeterFromMeasure(null);
			} else if (this.settings.interval) this.startPolling(this.settings.interval);
			else {	// preferred realtime meter mode
				await this.addListeners();
				await this.pollMeter();	// do immediate forced update
			}

		} catch (error) {
			this.error(error);
			this.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
			this.setUnavailable(error.message).catch(this.error);
		}
	}

	// migrate stuff from old version < 4.0.0
	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);
			// console.log(this.getName(), this.settings, this.getStore());

			// check and repair incorrect capability(order)
			const correctCaps = this.driver.ds.deviceCapabilities;
			for (let index = 0; index < correctCaps.length; index += 1) {
				const caps = await this.getCapabilities();
				const newCap = correctCaps[index];
				if (caps[index] !== newCap) {
					// remove all caps from here
					for (let i = index; i < caps.length; i += 1) {
						this.log(`removing capability ${caps[i]} for ${this.getName()}`);
						await this.removeCapability(caps[i])
							.catch((error) => this.log(error));
						await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
					}
					// add the new cap
					this.log(`adding capability ${newCap} for ${this.getName()}`);
					await this.addCapability(newCap);
					await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
				}
			}
			// fix meter_tariff currency versions <4.5.0
			const optionsMoney = this.getCapabilityOptions('meter_money_this_hour');
			const optionsTariff = this.getCapabilityOptions('meter_tariff');
			if (!optionsTariff.units) optionsTariff.units = { en: null };
			if (optionsMoney.units && (optionsMoney.units.en !== optionsTariff.units.en)) {
				optionsTariff.units = optionsMoney.units;
				optionsTariff.decimals = 4;
				this.log(`Fixing currency for meter_tariff ${this.getName()} to ${optionsTariff.units.en}`);
				await this.setCapabilityOptions('meter_tariff', optionsTariff).catch(this.error);
				await setTimeoutPromise(2 * 1000);
			}

			// convert tariff_via_flow to tariff_update_group <4.7.1
			if (this.getSettings().level < '4.7.1') {
				const group = this.getSettings().tariff_via_flow ? 1 : 0;
				this.log(`Migrating tariff group for ${this.getName()} to ${group}`);
				this.setSettings({ tariff_update_group: group });
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
				await this.setSettings({ meter_money_this_day: lastMoney.day });
				await this.setSettings({ meter_money_this_month: lastMoney.month });
				await this.setSettings({ meter_money_this_year: lastMoney.year });
				// await this.setCapabilityValue('meter_money_this_year', lastMoney.year);
				await this.unsetStoreValue('lastMoney');
			}
			// set new migrate level
			this.setSettings({ level: this.homey.app.manifest.version });
			this.migrated = true;
			Promise.resolve(this.migrated);
		} catch (error) {
			this.error('Migration failed', error);
			Promise.reject(error);
		}
	}

	async migrateCurrencyOptions(currency, decimals) {
		this.log('migrating money capability options');
		const options = {
			units: { en: currency },
			decimals,
		};
		if (!currency || currency === '') options.units.en = '¤';
		if (!Number.isInteger(decimals)) options.units.decimals = 2;
		const moneyCaps = this.getCapabilities().filter((name) => name.includes('money'));
		for (let i = 0; i < moneyCaps.length; i += 1) {
			this.log('migrating', moneyCaps[i]);
			await this.setCapabilityOptions(moneyCaps[i], options).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		this.log('migrating meter_tariff');
		options.decimals = 4;
		await this.setCapabilityOptions('meter_tariff', options).catch(this.error);
		await setTimeoutPromise(2 * 1000);
		this.currencyChanged = false;
		this.log('capability options migration ready', this.getCapabilityOptions('meter_money_last_hour'));
	}

	async migrateMeterOptions(decimals) {
		this.log('migrating meter capability options');
		const options = {
			units: { en: 'kWh' },
			decimals,
		};
		if (!Number.isInteger(decimals)) options.units.decimals = 4;
		const meterKWhCaps = this.getCapabilities().filter((name) => name.includes('meter_kwh'));
		// options.units = { en: 'kWh' };
		for (let i = 0; i < meterKWhCaps.length; i += 1) {
			this.log('migrating', meterKWhCaps[i]);
			await this.setCapabilityOptions(meterKWhCaps[i], options).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		if (this.hasCapability('meter_power')) {
			this.log('migrating meter_power');
			await this.setCapabilityOptions('meter_power', options).catch(this.error);
		}
		const meterM3Caps = this.getCapabilities().filter((name) => name.includes('meter_m3'));
		options.units = { en: 'm³' };
		for (let i = 0; i < meterM3Caps.length; i += 1) {
			this.log('migrating', meterM3Caps[i]);
			await this.setCapabilityOptions(meterM3Caps[i], options).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		if (this.hasCapability('meter_gas')) {
			this.log('migrating meter_gas');
			await this.setCapabilityOptions('meter_gas', options).catch(this.error);
		}
		if (this.hasCapability('meter_water')) {
			this.log('migrating meter_water');
			await this.setCapabilityOptions('meter_water', options).catch(this.error);
		}
		this.meterDecimalsChanged = false;
		this.log('meter capability options migration ready');
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		this.stopPolling();
		await this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!');
		await setTimeoutPromise(dly); // .then(() => this.onInitDevice());
		this.onInitDevice();
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
		this.log(`${this.getName()} device settings changed by user`, newSettings);

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

		const money = this.meterMoney;
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
		}

		if (changedKeys.includes('start_date')) {
			const now = new Date();
			const nowLocal = new Date(now.toLocaleString('en-GB', { timeZone: this.timeZone }));
			const thisMonth = nowLocal.getMonth();
			const thisYear = nowLocal.getFullYear();
			this.lastReadingMonth.month = thisMonth;
			this.lastReadingYear.year = thisYear;
		}

		if (changedKeys.includes('tariff')) {
			this.tariff = newSettings.tariff;
		}

		if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
			this.currencyChanged = true;
		}

		if (changedKeys.includes('decimals_meter')) {
			this.meterDecimalsChanged = true;
		}

		this.restartDevice(1000);
	}

	async destroyListeners() {
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
		this.homey.clearTimeout(this.timeoutIdRestart);
	}

	startPolling(interval) {
		this.homey.clearInterval(this.intervalIdDevicePoll);
		this.log(`start polling ${this.getName()} @${interval} minutes interval`);
		this.pollMeter().catch(this.error);
		this.intervalIdDevicePoll = this.homey.setInterval(async () => {
			try {
				await this.pollMeter();
			} catch (error) {
				this.error(error);
				this.setUnavailable(error.message).catch(this.error);
				this.restartDevice(10 * 60 * 1000); // restart after 10 minutes
			}
		}, 1000 * 60 * interval);
	}

	async setCapability(capability, value) {
		if (this.hasCapability(capability) && value !== undefined) {
			// only update changed capabilities
			if (value !== await this.getCapabilityValue(capability)) {
				this.setCapabilityValue(capability, value)
					.catch((error) => {
						this.error(error, capability, value);
					});
			}
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
		return reading;
	}

	async initDeviceValues() {
		if (!this.available) this.setAvailable().catch(this.error);
		this.log(`${this.getName()} Restoring device values after init`);

		// init daily resetting source devices
		this.dayStartCumVal = this.settings.meter_day_start;
		this.cumVal = this.dayStartCumVal;
		this.lastAbsVal = 0;

		// init this.startDay and this.startMonth
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

		// init this.lastMinMax
		if (!this.lastMinMax) this.lastMinMax = this.getStoreValue('lastMinMax');

		// PAIR init meter_power for use_measure_source
		const meterX = await this.getCapabilityValue(this.ds.cmap.meter_source);
		if (this.settings.use_measure_source && typeof meterX !== 'number') {
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

		// init this.tariff
		if (!this.tariff) this.tariff = this.settings.tariff;

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
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
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

	async updateMeter(val) { // , pollTm) { // pollTm is lastUpdated when using pollMethod
		try {
			if (typeof val !== 'number') return;
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
			if (!this.initReady) await this.initFirstReading(reading); // after app start
			const periods = await this.getPeriods(reading);	// check for new hour/day/month/year
			await this.updateMeters(reading, periods);
			await this.updateMoney(reading, periods);
			await this.updateMeasureMinMax(reading, periods);
		} catch (error) {
			this.error(error);
		}
	}

	async updateMeterFromFlow(val) {
		let value = val;
		if (value === null) { // poll requested
			value = await this.getCapabilityValue(this.ds.cmap.meter_source);
			if (value === null) return;
		}
		await this.updateMeter(value);
	}

	// takes Watt, creates kWh metervalue
	async updateMeterFromMeasure(val) {
		const measureTm = new Date();
		let value = val;
		if (value === null && !this.settings.homey_energy) { // poll requested or app init
			value = await this.getCapabilityValue(this.ds.cmap.measure_source);
			if (typeof value !== 'number') value = 0;
		}
		if (typeof value !== 'number') return;
		const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);
		// only update on >2 watt changes, or more then 2 minutes past
		if ((Math.abs(value - this.lastMeasure.value) > 2) || deltaTm > 120000) {
			const lastMeterValue = await this.getCapabilityValue(this.ds.cmap.meter_source);
			if (typeof lastMeterValue !== 'number') this.error('lastMeterValue is NaN, WTF');
			if (typeof deltaTm !== 'number') this.error('deltaTm is NaN, WTF');
			const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
			const meter = lastMeterValue + deltaMeter;
			this.lastMeasure = {
				value,
				measureTm,
			};
			await this.updateMeter(meter); // what to do with timestamp???
		}
	}

	async getPeriods(reading) { // MUST BE RUN BEFORE UPDATEMETERS!!!
		// check for new hour, day, month year
		const newHour = reading.hour !== this.lastReadingHour.hour;
		const newDay = (reading.day !== this.lastReadingDay.day);
		const newMonth = (newDay && (reading.day === this.startDay))
			|| ((reading.day >= this.startDay) && (reading.month > this.lastReadingMonth.month));
		const newYear = (newMonth && (reading.month === this.startMonth))
			|| ((reading.month >= this.startMonth) && (reading.year > this.lastReadingYear.year));
		if (newHour) this.log('new hour started');
		if (newDay) this.log('new day started');
		if (newMonth) this.log('new month started');
		if (newYear) this.log('(Happy!) new year started');
		const periods = {
			newHour, newDay, newMonth, newYear,
		};
		return Promise.resolve(periods);
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

	async updateMeasureMinMax({ ...reading }, periods) {
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
		const measureValue = this.driver.ds.driverId === 'power' ? measurePowerAvg : measureWaterAvg;
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

	async updateMoney({ ...reading }, periods) {
		// update tariff capability
		if (this.tariff !== await this.getCapabilityValue('meter_tariff')) this.setCapability('meter_tariff', this.tariff);
		// calculate money
		const deltaMoney = (reading.meterValue - this.meterMoney.meterValue) * this.tariff;
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
			await this.setSettings({ meter_money_last_hour: meterMoney.lastHour });
		}
		if (periods.newDay) {
			// new day started
			meterMoney.lastDay = meterMoney.day;
			meterMoney.day = 0;
			fixedMarkup += this.getSettings().markup_day;
			await this.setCapability('meter_money_last_day', meterMoney.lastDay);
			await this.setSettings({ meter_money_last_day: meterMoney.lastDay });
		}
		if (periods.newMonth) {
			// new month started
			meterMoney.lastMonth = meterMoney.month;
			meterMoney.month = 0;
			fixedMarkup += this.getSettings().markup_month;
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
		this.meterMoney = { ...meterMoney };
		// Update settings every hour
		if (periods.newHour) {
			await this.setSettings({ meter_money_this_day: meterMoney.day });
			await this.setSettings({ meter_money_this_month: meterMoney.month });
			await this.setSettings({ meter_money_this_year: meterMoney.year });
		}
	}

	async updateMeters({ ...reading }, periods) {
		this.setCapability(this.ds.cmap.meter_source, reading.meterValue);
		// calculate meters
		let valHour = reading.meterValue - this.lastReadingHour.meterValue;
		let valDay = reading.meterValue - this.lastReadingDay.meterValue;
		let valMonth = reading.meterValue - this.lastReadingMonth.meterValue;
		let valYear = reading.meterValue - this.lastReadingYear.meterValue;
		// set capabilities
		if (periods.newHour) {
			// new hour started
			this.setCapability(this.ds.cmap.last_hour, valHour);
			this.lastReadingHour = reading;
			await this.setStoreValue('lastReadingHour', reading);
			await this.setSettings({ meter_latest: `${reading.meterValue}` });
			valHour = 0;
		}
		if (periods.newDay) {
			// new day started
			this.setCapability(this.ds.cmap.last_day, valDay);
			this.lastReadingDay = reading;
			await this.setStoreValue('lastReadingDay', reading);
			await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue });
			valDay = 0;
		}
		if (periods.newMonth) {
			// new month started
			this.setCapability(this.ds.cmap.last_month, valMonth);
			this.lastReadingMonth = reading;
			await this.setStoreValue('lastReadingMonth', reading);
			await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue });
			valMonth = 0;
		}
		if (periods.newYear) {
			// new year started
			this.setCapability(this.ds.cmap.last_year, valYear);
			this.lastReadingYear = reading;
			await this.setStoreValue('lastReadingYear', reading);
			await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue });
			valYear = 0;
		}
		// console.log(this.getName(), valHour, valDay, valMonth, valYear);
		this.setCapability(this.ds.cmap.this_hour, valHour);
		this.setCapability(this.ds.cmap.this_day, valDay);
		this.setCapability(this.ds.cmap.this_month, valMonth);
		this.setCapability(this.ds.cmap.this_year, valYear);
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
