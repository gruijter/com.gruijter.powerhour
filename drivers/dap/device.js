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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const Homey = require('homey');
const util = require('util');
const DAPEL = require('../../entsoe');
const DAPGASTTF = require('../../frankenergy');
const DAPGASLEBA = require('../../easyenergy');
const ECB = require('../../ecb_exchange_rates');
// const { info } = require('console');

const setTimeoutPromise = util.promisify(setTimeout);

// calculate the average price of an array of prices
const average = (array) => array.reduce((partialAvg, value) => partialAvg + value / array.length, 0);

class MyDevice extends Homey.Device {

	async onInit() {
		try {
			await this.destroyListeners();
			this.restarting = false;
			this.settings = await this.getSettings();
			if (!this.migrated) await this.migrate();

			this.timeZone = this.homey.clock.getTimezone();
			this.fetchDelay = Math.floor(Math.random() * 30 * 60 * 1000);
			// if (!this.prices) this.prices = [];

			if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);

			this.exchange = new ECB();
			if (this.settings.biddingZone === 'TTF_EOD') {
				this.dap = new DAPGASTTF();
			} else if (this.settings.biddingZone === 'TTF_LEBA') {
				this.dap = new DAPGASLEBA();
			} else {
				// setup ENTSOE DAP
				const apiKey = Homey.env ? Homey.env.ENTSOE_API_KEY : '';
				this.dap = new DAPEL({ apiKey, biddingZone: this.settings.biddingZone });
			}

			// start fetching prices on every hour
			this.eventListenerHour = async () => {
				this.log('new hour event received');
				await this.fetchExchangeRate();
				await this.handlePrices();
				await setTimeoutPromise(this.fetchDelay, 'waiting is done'); // spread over 20 minutes for API rate limit (400 / min)
				await this.fetchPrices();
			};
			this.homey.on('everyhour', this.eventListenerHour);

			// fetch prices now
			await this.fetchExchangeRate();
			await this.fetchPrices();
			await this.handlePrices();

			this.log(`${this.getName()} has been initialized`);
		} catch (error) {
			this.error(error);
			// this.setUnavailable(error.message).catch(this.error);
			this.restartDevice(1 * 60 * 1000); // restart after 1 minute
		}
	}

	// migrate stuff from old version < 4.3.6
	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);
			// console.log(this.getName(), this.settings, this.getStore());

			// check and repair incorrect capability(order)
			let correctCaps = this.driver.deviceCapabilitiesPower;
			if (this.settings.biddingZone === 'TTF_EOD' || this.settings.biddingZone === 'TTF_LEBA') correctCaps = this.driver.deviceCapabilitiesGas;
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

			// check this.settings.fetchExchangeRate  < 4.4.1
			if (this.settings.level < '4.4.1') {
				this.log('migrating fixed markup to exclude exchange rate');
				await this.setSettings({ fixedMarkup: this.settings.fixedMarkup * this.settings.exchangeRate });
			}

			// set new migrate level
			await this.setSettings({ level: this.homey.app.manifest.version });
			this.settings = await this.getSettings();
			this.migrated = true;
			Promise.resolve(this.migrated);
		} catch (error) {
			this.error('Migration failed', error);
			Promise.reject(error);
		}
	}

	async migrateCurrencyOptions(currency, decimals) {
		this.log('migrating capability options');
		const options = {
			units: { en: currency },
			decimals,
		};
		if (!currency || currency === '') options.units.en = '€';
		if (!Number.isInteger(decimals)) options.units.decimals = 4;
		const moneyCaps = this.getCapabilities().filter((name) => name.includes('price'));
		for (let i = 0; i < moneyCaps.length; i += 1) {
			this.log('migrating', moneyCaps[i]);
			await this.setCapabilityOptions(moneyCaps[i], options).catch(this.error);
			await setTimeoutPromise(2 * 1000);
		}
		this.currencyChanged = false;
		this.log('capability options migration ready', this.getCapabilityOptions('meter_price_h7'));
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		await this.destroyListeners();
		const dly = delay || 2000;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting. Wait a few minutes!');
		await setTimeoutPromise(dly).then(() => this.onInit());
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
	async onSettings({ newSettings, changedKeys }) { // , oldSettings) {
		this.log(`${this.getName()} device settings changed by user`, newSettings);
		if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
			this.currencyChanged = true;
		}
		this.restartDevice(1000);
	}

	async destroyListeners() {
		if (this.eventListenerHour) await this.homey.removeListener('everyhour', this.eventListenerHour);
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

	async setVariableMarkup(val) {
		this.log('changing variable markup via flow', this.getName(), val);
		await this.setSettings({ variableMarkup: val });
		this.restartDevice(1000);
	}

	async setFixedMarkup(val) {
		this.log('changing fixed markup via flow', this.getName(), val);
		await this.setSettings({ fixedMarkup: val });
		this.restartDevice(1000);
	}

	async setFixedMarkupDay(val) {
		this.log('changing Day markup via flow', this.getName(), val);
		await this.setSettings({ fixedMarkupDay: val });
		this.restartDevice(1000);
	}

	async setFixedMarkupNight(val) {
		this.log('changing Night markup via flow', this.getName(), val);
		await this.setSettings({ fixedMarkupNight: val });
		this.restartDevice(1000);
	}

	async setExchangeRate(val) {
		this.log('changing exchange rate via flow', this.getName(), val);
		await this.setSettings({ exchangeRate: val });
		this.restartDevice(1000);
	}

	async fetchExchangeRate() {
		try {
			const currency = this.settings.fetchExchangeRate;
			if (currency !== 'NONE') {
				this.log(`fetching exchange rate with ${currency}`);
				const rates = await this.exchange.getRates();
				const val = rates[this.settings.fetchExchangeRate];
				if (typeof val !== 'number') throw Error('result is not a number', val);
				if (val !== this.settings.exchangeRate) {
					this.log('new exchange rate:', val);
					await this.setSettings({ exchangeRate: val });
					this.settings = await this.getSettings();
				}
			}
		} catch (error) {
			this.error(error);
		}
	}

	async priceIsLowest(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		let minimum = Math.min(...this.state.pricesThisDay);
		if (args.period !== 'this_day') minimum = Math.min(...this.state.pricesNext8h.slice(0, Number(args.period)));
		return this.state.priceNow <= minimum;
	}

	async priceIsLowestToday(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		// sort and select number of lowest prices
		const lowestNPrices = [...this.state.pricesThisDay].sort().slice(0, args.number);
		return this.state.priceNow <= Math.max(...lowestNPrices);
	}

	async priceIsLowestBefore(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		// calculate start and end hours compared to present hour
		const thisHour = this.state.H0; // e.g. 23 hrs
		let endHour = args.time; // e.g. 2 hrs
		if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
		let startHour = endHour - args.period; // e.g. 26 - 4 = 22 hrs
		// check if present hour is in scope op selected period
		if ((thisHour >= endHour) || (thisHour < startHour)) return false;
		// get period (2-8) hours pricing before end time
		let pricesPartYesterday = [];
		if (startHour < 0) {
			pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
			startHour = 0;
		}
		let pricesPartTomorrow = [];
		if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
		const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
		const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
		// sort and select number of lowest prices
		const lowestNPrices = pricesTotalPeriod.sort().slice(0, args.number);
		return this.state.priceNow <= Math.max(...lowestNPrices);
	}

	async priceIsLowestAvg(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
		let prices = [...this.state.pricesNext8h];
		// calculate all avg prices for x hour periods for next 8 hours
		const avgPricesNext8h = [];
		prices.forEach((price, index) => {
			if (index > prices.length - Number(args.hours)) return;
			const hours = prices.slice(index, (index + Number(args.hours)));
			const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
			avgPricesNext8h.push(avgPrice);
		});
		let minAvgPrice = Math.min(...avgPricesNext8h);
		// calculate all avg prices for x hour periods for this_day
		if (args.period === 'this_day') {
			prices = [...this.state.pricesThisDay];
			const avgPricesThisDay = [];
			prices.forEach((price, index) => {
				if (index > prices.length - Number(args.hours)) return;
				const hours = prices.slice(index, (index + Number(args.hours)));
				const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
				avgPricesThisDay.push(avgPrice);
			});
			minAvgPrice = Math.min(...avgPricesThisDay);
		}
		return avgPricesNext8h[0] <= minAvgPrice;
	}

	async priceIsHighest(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		let maximum = Math.max(...this.state.pricesThisDay);
		if (args.period !== 'this_day') maximum = Math.max(...this.state.pricesNext8h.slice(0, Number(args.period)));
		return this.state.priceNow >= maximum;
	}

	async priceIsHighestAvg(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
		let prices = [...this.state.pricesNext8h];
		// calculate all avg prices for x hour periods for next 8 hours
		const avgPricesNext8h = [];
		prices.forEach((price, index) => {
			if (index > prices.length - Number(args.hours)) return;
			const hours = prices.slice(index, (index + Number(args.hours)));
			const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
			avgPricesNext8h.push(avgPrice);
		});
		let maxAvgPrice = Math.max(...avgPricesNext8h);
		// calculate all avg prices for x hour periods for this_day
		if (args.period === 'this_day') {
			prices = [...this.state.pricesThisDay];
			const avgPricesThisDay = [];
			prices.forEach((price, index) => {
				if (index > prices.length - Number(args.hours)) return;
				const hours = prices.slice(index, (index + Number(args.hours)));
				const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
				avgPricesThisDay.push(avgPrice);
			});
			maxAvgPrice = Math.max(...avgPricesThisDay);
		}
		return avgPricesNext8h[0] >= maxAvgPrice;
	}

	async priceIsBelowAvg(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		const percent = 100 * (1 - this.state.priceNow / this.state[args.period]);
		return percent >= Number(args.percent);
	}

	async priceIsAboveAvg(args) {
		if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
		const percent = 100 * (this.state.priceNow / this.state[args.period] - 1);
		return percent >= Number(args.percent);
	}

	async newPricesReceived(prices, period) {
		this.log(`${this.getName()} received new prices for ${period}`, prices);
		let pricesMU = await this.markUpPrices(prices);
		pricesMU = pricesMU.map((price) => Math.round(price * 10000) / 10000);
		const priceString = JSON.stringify(({ ...pricesMU }));
		const tokens = { prices: priceString };
		const state = { period };
		this.homey.app.newPrices(this, tokens, state);
	}

	async fetchPrices() {
		try {
			// check if fetching of prices is needed
			// const now = new Date();
			// const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
			// // check if already have prices today
			// let havePricesToday = false;
			// if (this.prices && this.prices[0] && this.prices[0].timeInterval) {
			// 	// check for 24 hours of pricing today
			// 	if (this.prices[0].prices.length !== 24) return;
			// 	// check for correct date
			// 	const priceDateToday = new Date(new Date(this.prices[0].timeInterval.start).toLocaleString('en-US', { timeZone: this.timeZone }));
			// 	if (priceDateToday.getDate() !== nowLocal.getDate()) return;
			// 	havePricesToday = true;
			// 	console.log(this.getName(), 'has all prices today', this.prices[0]);
			// }
			// // check if already have prices tomorrow
			// let havePricesTomorrow = false;
			// if (this.prices && this.prices[1] && this.prices[1].timeInterval) {
			// 	const tomorrowLocal = nowLocal;
			// 	tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
			// 	// check for 24 hours of pricing tomorrow
			// 	if (this.prices[1].prices.length !== 24) return;
			// 	// check for correct date
			// 	const priceDateTomorrow = new Date(new Date(this.prices[1].timeInterval.start).toLocaleString('en-US', { timeZone: this.timeZone }));
			// 	if (priceDateTomorrow.getDate() !== tomorrowLocal.getDate()) return;
			// 	havePricesTomorrow = true;
			// 	console.log(this.getName(), 'has all prices tomorrow', this.prices[1]);
			// }
			// if (havePricesToday && havePricesTomorrow) {
			// 	this.log(this.getName(), 'Skip fetching prices. Already have all pricing for today and tomorrow.');
			// 	return;
			// }
			// console.log(this.getName(), havePricesToday, havePricesTomorrow, this.prices);

			this.log(this.getName(), 'fetching prices of today and tomorrow (when available)');

			// set UTC start of today and tomorrow according to local Homey timezone
			const todayStart = new Date();
			todayStart.setMilliseconds(0);
			todayStart.setHours(0);
			todayStart.setMinutes(0);
			todayStart.setSeconds(0);
			todayStart.setMilliseconds(0);
			const offset = new Date(todayStart.toLocaleString('en-US', { timeZone: this.timeZone })) - todayStart;
			todayStart.setMilliseconds(-offset);
			const tomorrowStart = new Date(todayStart);
			tomorrowStart.setDate(tomorrowStart.getDate() + 2);

			const prices = await this.dap.getPrices({ dateStart: todayStart, dateEnd: tomorrowStart })
				.catch(async (error) => {
					this.log(`${this.getName()} Error fetching prices from ${this.dap.host}. Trying again in 10 minutes`, error.message);
					await setTimeoutPromise(10 * 60 * 1000, 'waiting is done');
					return this.dap.getPrices().catch(this.error);
				});
			if (!prices[0]) throw Error('something went wrong fetching prices');
			if (!this.prices || this.prices.length < 1) {
				this.prices = [];
				this.log(`${this.getName()} received first prices for today.`);
				if (prices.length > 1) this.log(`${this.getName()} received first prices for tomorrow.`);
			}
			if (prices[0].prices.length !== 24) this.log(`${this.getName()} did not receive 24 hours of prices for today`);
			// if ((this.prices.length === 1 && prices.length === 2)
			// 	|| (this.prices.length === 2 && this.prices[1].prices.length !== 24 && prices.length === 2 && prices[1].prices.length === 24)) {
			// 	this.log(`${this.getName()} received new prices for tomorrow.`);
			// }
			if (prices[1] && prices[1].prices.length !== 24) this.log(`${this.getName()} did not receive 24 hours of prices for tomorrow`);

			// check if prices changed
			if (prices[0] && (!this.prices || !this.prices[0])) await this.newPricesReceived(prices[0], 'this_day');
			if (prices[0] && this.prices && this.prices[0] && JSON.stringify(prices[0].prices) !== JSON.stringify(this.prices[0].prices)) {
				await this.newPricesReceived(prices[0], 'this_day');
			}
			if (prices[1] && (!this.prices || !this.prices[1])) await this.newPricesReceived(prices[1], 'tomorrow');
			if (prices[1] && this.prices && this.prices[1] && JSON.stringify(prices[1].prices) !== JSON.stringify(this.prices[1].prices)) {
				await this.newPricesReceived(prices[1], 'tomorrow');
			}
			this.prices = prices;
		} catch (error) {
			this.error(error);
		}
	}

	// add markUp for a day [0...23], and convert from mWh>kWh
	async markUpPrices(priceInfo) {
		if (!priceInfo.timeInterval) return priceInfo.prices;
		const priceDate = new Date(new Date(priceInfo.timeInterval.start).toLocaleString('en-US', { timeZone: this.timeZone }));
		const isWeekend = priceDate.getDay() === 0 || priceDate.getDay() === 6; // 0 = sunday, 6 = saturday
		const array = [...priceInfo.prices];
		return array.map((price, index) => {
			let muPrice = ((price * this.settings.exchangeRate * (1 + this.settings.variableMarkup / 100)) / 1000) + this.settings.fixedMarkup;
			if ((this.settings.weekendHasNightMarkup && isWeekend)
				|| ((index >= 22) || (index < 6))) { muPrice += this.settings.fixedMarkupNight;	} else { muPrice += this.settings.fixedMarkupDay; }
			return muPrice;
		});
	}

	async handlePrices() {
		try {
			if (!this.prices || !this.prices[0]) throw Error('no price info available');
			const prices = [...this.prices];

			// get the present hour (0 - 23)
			const now = new Date();
			const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
			const H0 = nowLocal.getHours();

			// check for correct date, if new day shift prices[0]
			let priceDate = new Date(new Date(prices[0].timeInterval.start).toLocaleString('en-US', { timeZone: this.timeZone }));
			if (priceDate.getDate() !== nowLocal.getDate()) {
				this.pricesYesterday = prices.shift();
				this.log(`${this.getName()} shifted price information to yesterday.`);
				if (!prices[0]) throw Error('No price information available for this day');
				priceDate = new Date(new Date(prices[0].timeInterval.start).toLocaleString('en-US', { timeZone: this.timeZone }));
				if (priceDate.getDate() !== nowLocal.getDate()) throw Error('Available price information is for incorrect day');
			}

			// Array pricesYesterday with markUp
			if (!this.pricesYesterday || !this.pricesYesterday.prices) {
				this.log(`${this.getName()} has no price information available for yesterday`);
				this.pricesYesterday = 	{ prices: [] };
			}
			const pricesYesterday = await this.markUpPrices(this.pricesYesterday);
			// Array pricesTomorrow with markUp
			let pricesTomorrow = [];
			if (prices[1] && prices[1].prices) pricesTomorrow = await this.markUpPrices(prices[1]);

			// Array pricesThisDay with markUp
			const pricesThisDay = await this.markUpPrices(prices[0]);
			const priceThisDayAvg = average(pricesThisDay);

			// Array pricesNext8h with markUp
			const pricesTodayAndTomorrow = pricesThisDay.concat(pricesTomorrow);
			const pricesNext8h = pricesTodayAndTomorrow.slice(H0, H0 + 8);
			if (pricesNext8h.length < 8) throw Error('Next 8 hour prices are not available');
			const priceNext8hAvg = average(pricesNext8h);
			const priceNow = pricesNext8h[0];

			// find lowest price today
			const priceThisDayLowest = Math.min(...pricesThisDay);
			const hourThisDayLowest = pricesThisDay.indexOf(priceThisDayLowest);

			// set capabilities
			await this.setCapability('meter_price_this_day_lowest', priceThisDayLowest);
			await this.setCapability('hour_this_day_lowest', hourThisDayLowest);
			await this.setCapability('meter_price_this_day_avg', priceThisDayAvg);
			await this.setCapability('meter_price_next_8h_avg', priceNext8hAvg);
			const allSet = pricesNext8h.map((price, index) => this.setCapability(`meter_price_h${index}`, price).catch(this.error));
			await Promise.all(allSet);

			// send tariff to power or gas driver
			let sendTo = 'set_tariff_power';
			if (this.settings.biddingZone === 'TTF_EOD' || this.settings.biddingZone === 'TTF_LEBA') sendTo = 'set_tariff_gas';
			if (this.settings.sendTariff) await this.homey.emit(sendTo, { tariff: priceNow });

			// trigger flow cards
			const tokens = { meter_price_h0: pricesNext8h[0] };
			const state = {
				pricesYesterday,
				pricesThisDay,
				pricesTomorrow,
				H0,
				priceNow,
				pricesNext8h,
				this_day_avg: priceThisDayAvg,
				next_8h_avg: priceNext8hAvg,
			};
			this.state = state;
			this.homey.app.triggerPriceHighest(this, tokens, state);
			this.homey.app.triggerPriceAboveAvg(this, tokens, state);
			this.homey.app.triggerPriceHighestAvg(this, tokens, state);
			this.homey.app.triggerPriceLowest(this, tokens, state);
			this.homey.app.triggerPriceLowestBefore(this, tokens, state);
			this.homey.app.triggerPriceLowestToday(this, tokens, state);
			this.homey.app.triggerPriceBelowAvg(this, tokens, state);
			this.homey.app.triggerPriceLowestAvg(this, tokens, state);

		} catch (error) {
			this.error(error);
		}
	}

}

module.exports = MyDevice;
