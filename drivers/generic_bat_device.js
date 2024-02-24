/* eslint-disable no-await-in-loop */
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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { Device } = require('homey');
const util = require('util');
const charts = require('../charts');
const tradeStrategy = require('../hedge_strategy'); // deprecated
const roiStrategy = require('../hedge_roi_glpk'); // new method

const setTimeoutPromise = util.promisify(setTimeout);

class batDevice extends Device {

	// this method is called when the Device is inited
	async onInitDevice() {
		try {
			// init some stuff
			this.restarting = false;
			this.initReady = false;
			// this.initReady = false;
			this.destroyListeners();
			this.timeZone = this.homey.clock.getTimezone();

			if (!this.migrated) await this.migrate();
			this.migrated = true;
			if (this.currencyChanged) await this.migrateCurrencyOptions(this.getSettings().currency, this.getSettings().decimals);
			await this.setAvailable().catch(this.error);

			// restore device values
			await this.initDeviceValues();

			// start listeners
			await this.addListeners();

			// poll first values
			await this.poll();

			this.initReady = true;

			// create Strategy and ROI chart
			if (this.getSettings().roiEnable) {
				await setTimeoutPromise(10000 + (Math.random() * 10000)).catch(this.error);
				this.triggerNewRoiStrategyFlow().catch(this.error);
				await setTimeoutPromise(20000 + (Math.random() * 10000)).catch(this.error);
				this.updateChargeChart().catch(this.error);
			}

		} catch (error) {
			this.error(error);
			// this.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
			this.setUnavailable(error.message).catch(this.error);
			this.initReady = false; // retry after 5 minutes
		}
	}

	async onUninit() {
		this.log(`Homey is killing ${this.getName()}`);
		this.destroyListeners();
		let delay = 1500;
		if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
		await setTimeoutPromise(delay);
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

			// check if on HP2023 > add advanced ROI capabilities
			const HP2023 = this.homey.platformVersion === 2;
			if (HP2023 && this.getSettings().roiEnable) {
				correctCaps.push('roi_duration');
			}

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
				}
			}

			// set new migrate level
			await this.setSettings({ level: this.homey.app.manifest.version }).catch(this.error);
			Promise.resolve(true);
		} catch (error) {
			this.error('Migration failed', error);
			Promise.reject(error);
		}
	}

	async migrateCurrencyOptions(currency, decimals) {
		this.log('migrating capability options');
		this.setUnavailable('Device is migrating. Please wait!').catch(this.error);
		const options = {
			units: { en: currency },
			decimals,
		};
		if (!currency || currency === '') options.units.en = '€';
		if (!Number.isInteger(decimals)) options.decimals = 4;
		const moneyCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_money') || name.includes('meter_tariff'));
		for (let i = 0; i < moneyCaps.length; i += 1) {
			this.log(`migrating ${moneyCaps[i]} to use ${options.units.en} and ${options.decimals} decimals`);
			await this.setCapabilityOptions(moneyCaps[i], options).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		this.currencyChanged = false;
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
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
		if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
			this.currencyChanged = true;
		}
		if (changedKeys.includes('meter_kwh_charging')) await this.setCapability('meter_kwh_charging', newSettings.meter_kwh_charging);
		if (changedKeys.includes('meter_kwh_discharging'))	await this.setCapability('meter_kwh_discharging', newSettings.meter_kwh_discharging);
		if (changedKeys.includes('roiEnable')) {
			const HP2023 = this.homey.platformVersion === 2;
			if (!HP2023 && newSettings.roiEnable) throw Error('Advanced ROI is only available on HP2023!');
		}
		this.restartDevice(2000);
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
	// BASIC STRATEGY FLOW (HP2016/2019)
	async priceBattBestTrade(args) {
		await setTimeoutPromise(3000); // wait 3 seconds for new hourly prices to be taken in
		if (!this.pricesNextHours) throw Error('no prices available');
		const { chargePower } = this.getSettings(); // max power
		const { dischargePower } = this.getSettings(); // max power
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

	// ADVANCED STRATEGY FLOW (HP2023)
	async findRoiStrategy(args) {
		try {
			if (!this.getSettings().roiEnable)	return Promise.resolve(null);
			this.log(`ROI strategy calculation started for ${this.getName()} minPriceDelta:`, args.minPriceDelta);
			if (this.getSettings().roiMinProfit !== args.minPriceDelta) this.setSettings({ roiMinProfit: args.minPriceDelta }).catch(this.error);
			await setTimeoutPromise(3000); // wait 3 seconds for new hourly prices to be taken in
			if (!this.pricesNextHours) throw Error('no prices available');
			const settings = this.getSettings();
			const chargeSpeeds = [
				{
					power: settings.chargePower, // Watt. Max speed charging power in Watt (on AC side), loss is included
					eff: 1 - (settings.chargeLoss / 100), // efficiency when using Max speed charging
				},
				{
					power: settings.chargePowerEff, // Watt. Efficient charging power in Watt (on AC side), loss is included
					eff: 1 - (settings.chargeLossEff / 100), // efficiency when using Efficient charging
				},
				{
					power: settings.chargePower3, // Watt. Additional charging power in Watt (on AC side), loss is included
					eff: 1 - (settings.chargeLoss3 / 100), // efficiency when using additional charging
				},
			].filter((speed) => speed.power);
			const dischargeSpeeds = [	// defaults to Sessy values
				{
					power: settings.dischargePower, // Watt. Max speed discharging power in Watt (on AC side), loss is included
					eff: 1 - (settings.dischargeLoss / 100), // efficiency when using Max speed discharging
				},
				{
					power: settings.dischargePowerEff, // Watt. Efficient discharging power in Watt (on AC side), loss is included
					eff: 1 - (settings.dischargeLossEff / 100), // efficiency when using Efficient discharging
				},
				{
					power: settings.dischargePower3, // Watt. Additional discharging power in Watt (on AC side), loss is included
					eff: 1 - (settings.dischargeLoss3 / 100), // efficiency when using additional discharging
				},
			].filter((speed) => speed.power);	// remove 0W entries
			const now = new Date();
			const startMinute = now.getMinutes();
			const options = {
				prices: [...this.pricesNextHours],
				minPriceDelta: args.minPriceDelta,
				soc: this.soc,
				startMinute,
				batCapacity: this.getSettings().batCapacity,
				chargeSpeeds,
				dischargeSpeeds,
			};
			const stratOptsString = JSON.stringify(options);
			if (this.lastStratOptsString === stratOptsString) {
				this.log('Strategy is pulled from cache', this.getName());
				return Promise.resolve(this.lastStratTokens);
			}
			const strat = roiStrategy.getStrategy(options);
			const tokens = {
				power: strat[0].power,
				duration: strat[0].duration,
				endSoC: strat[0].soc,
				scheme: JSON.stringify(strat),
			};
			this.lastStratOptsString = stratOptsString;
			this.lastStratTokens = { ...tokens };
			// global.gc();
			return Promise.resolve(tokens);
		} catch (error) {
			return Promise.reject(error);
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

		// init pricesNextHours
		if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = await this.getStoreValue('pricesNextHoursMarketLength');
		if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = 99;
		if (!this.pricesNextHours) this.pricesNextHours = await this.getStoreValue('pricesNextHours');
		if (!this.pricesNextHours) {
			this.pricesNextHours = [0.25]; // set as default after pair
			// get DAP prices when available
			this.driver.setPricesDevice(this);
		}

		// init incoming meter queue
		if (!this.newReadings) this.newReadings = [];

		// init this.soc
		const storedkWh = await this.getCapabilityValue('meter_kwh_stored');
		this.soc = (storedkWh / this.getSettings().batCapacity) * 100;
		if (!this.soc) this.soc = 0;

		// init XOM
		this.xomTargetPower = 0;

		// init this.startDay, this.startMonth and this.year
		let startDateString = this.getSettings().start_date;
		if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
		this.startDay = Number(startDateString.slice(0, 2));
		this.startMonth = Number(startDateString.slice(2, 4));
		if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
		if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
		this.startMonth -= 1; // January is month 0

		// init this.lastReading
		if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
		if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
		if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
		if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

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

		// update kWh readings in settings
		const meterCharging = await this.getCapabilityValue('meter_kwh_charging');
		const meterDischarging = await this.getCapabilityValue('meter_kwh_discharging');
		if (meterCharging) await this.setSettings({ meter_kwh_charging: meterCharging }).catch(this.error);
		if (meterDischarging) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch(this.error);
	}

	// init some stuff when first reading comes in
	async initFirstReading({ ...reading }) {
		// check pair init
		const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
		if (pairInit) {
			this.log(`${this.getName()} Setting values after pair init`);
			await this.setStoreValue('lastReadingHour', reading);
			this.lastReadingHour = reading;
			const dayStart = this.getSettings().homey_device_daily_reset ? this.getReadingObject(0) : reading;
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
		this.initReady = true;
	}

	// update the prices from DAP
	async updatePrices(pricesNextHours, pricesNextHoursMarketLength) {
		try {
			if (!pricesNextHours || !pricesNextHours[0]) return;
			this.pricesNextHoursMarketLength = pricesNextHoursMarketLength;
			if (!this.initReady || JSON.stringify(pricesNextHours) === JSON.stringify(this.pricesNextHours)) return; // only update when changed
			this.pricesNextHours = pricesNextHours;
			this.setCapability('meter_tariff', pricesNextHours[0]);
			this.setStoreValue('pricesNextHours', pricesNextHours);
			this.setStoreValue('pricesNextHoursMarketLength', pricesNextHoursMarketLength);
			// trigger ROI card
			if (this.getSettings().roiEnable) {
				await this.triggerNewRoiStrategyFlow();
				await this.updateChargeChart();
			}
		} catch (error) {
			this.error(error);
		}
	}

	// trigger XOM flow cards SEE BAT DRIVER

	// trigger ROI flow cards
	async triggerNewRoiStrategyFlow() {
		try {
			if (!this.getSettings().roiEnable) return Promise.resolve(null);
			await setTimeoutPromise(5000 + Math.random() * 20000);
			// get all minPriceDelta as entered by user in trigger flows for this device
			const argValues = await this.homey.app._newRoiStrategy.getArgumentValues(this);
			const uniqueArgs = argValues.filter((a, idx) => argValues.findIndex((b) => b.minPriceDelta === argValues[idx].minPriceDelta) === idx);
			uniqueArgs.forEach(async (args) => {
				const tokens = await this.findRoiStrategy(args).catch(this.error);
				if (tokens) {
					const state = args;
					this.homey.app.triggerNewRoiStrategy(this, tokens, state);
					this.reTriggerNewRoiStrategyFlow(tokens, args).catch(this.error);
				}
			});
			await setTimeoutPromise(5000 + Math.random() * 20000);
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// re-trigger ROI flow cards when duration ends
	async reTriggerNewRoiStrategyFlow(tokens, args) {
		try {
			const {
				duration, power, endSoC, scheme,
			} = tokens;
			if (duration === 0) return;
			const now = new Date();
			const startMinute = now.getMinutes();
			if ((startMinute + duration) >= 55) return;		// do not retrigger if duration is crossing to next hour
			if (power > 0 && endSoC <= 1) return;			// do not retrigger when discharging to empty
			if (power < 0 && endSoC >= 99) return;		// do not retrigger when charging to full
			// Retrigger after delay when partly charging or discharging
			this.log(`Stopping ROI in ${startMinute + duration} minutes`, this.getName());
			const delay = (startMinute + duration) * 60 * 1000;
			await setTimeoutPromise(delay).catch(this.error);
			const state = args;
			const newTokens = {
				power: 0, duration: 0, endSoC, scheme,
			};
			this.log('Stopping ROI', this.getName());
			this.homey.app.triggerNewRoiStrategy(this, newTokens, state);
		} catch (error) {
			this.error(error);
		}
	}

	async updateChargeChart() {
		if (!this.pricesNextHours) throw Error('no prices available');
		this.log('updating charge chart', this.getName());
		const minPriceDelta = this.getSettings().roiMinProfit;
		const strategy = await this.findRoiStrategy({ minPriceDelta }).catch(this.error);
		if (strategy) {
			this.setCapability('roi_duration', strategy.duration);
			const now = new Date();
			now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
			const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
			const H0 = nowLocal.getHours();
			// eslint-disable-next-line max-len
			const urlNextHours = await charts.getChargeChart(strategy, H0, this.pricesNextHoursMarketLength, this.getSettings().chargePower, this.getSettings().dischargePower);
			if (!this.nextHoursChargeImage) {
				this.nextHoursChargeImage = await this.homey.images.createImage();
				await this.nextHoursChargeImage.setUrl(urlNextHours);
				await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
			} else {
				await this.nextHoursChargeImage.setUrl(urlNextHours);
			}
			await this.nextHoursChargeImage.update().catch(this.error);
		}
		return Promise.resolve(true);
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

	// takes Watt, creates kWh metervalue
	async updateMeterFromMeasure(val) {
		if (!this.migrated) return;
		const measureTm = new Date();
		let value = val;
		// apply power corrections
		// charging CHARGE POWER IS ON AC SIDE, SO NO LOSS CORRECTION NEEDED
		// if (val < 0) value /= (1 - this.getSettings().chargeLoss / 100); // add max charge loss
		// discharging DISCHARGE POWER IS ON AC SIDE, SO NO LOSS CORRECTION NEEDED
		// if (val > 0) value *= (1 - this.getSettings().dischargeLoss / 100); // substract max discharge loss
		// standby
		if (val === 0) value -= this.getSettings().ownPowerStandby; // substract standby usage

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
			await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch(this.error);
			// update kWh readings in settings
			const meterCharging = await this.getCapabilityValue('meter_kwh_charging');
			const meterDischarging = await this.getCapabilityValue('meter_kwh_discharging');
			if (meterCharging) await this.setSettings({ meter_kwh_charging: meterCharging }).catch(this.error);
			if (meterDischarging) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch(this.error);
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
			await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch(this.error);
		}
		if (periods.newMonth) {
			// new month started
			meterMoney.lastMonth = meterMoney.month;
			meterMoney.month = 0;
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
		// update money_this_x capabilities
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

}

module.exports = batDevice;
