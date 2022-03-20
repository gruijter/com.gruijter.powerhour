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
const DAPGAS = require('../../frankenergy');

const setTimeoutPromise = util.promisify(setTimeout);

// calculate the average price of an array of prices
const average = (array) => array.reduce((partialAvg, value) => partialAvg + value / array.length, 0);

class MyDevice extends Homey.Device {

	async onInit() {
		try {
			await this.destroyListeners();
			this.restarting = false;
			this.settings = await this.getSettings();
			this.timeZone = this.homey.clock.getTimezone();
			this.fetchDelay = Math.floor(Math.random() * 15 * 60 * 1000);
			// if (!this.prices) this.prices = [];

			if (this.settings.biddingZone === 'TTF_EOD') {
				this.dap = new DAPGAS();
			} else {
				// setup ENTSOE DAP
				const apiKey = Homey.env ? Homey.env.ENTSOE_API_KEY : '';
				this.dap = new DAPEL({ apiKey, biddingZone: this.settings.biddingZone });
			}

			// start fetching prices on every hour
			this.eventListenerHour = async () => {
				this.log('new hour event received');
				await this.handlePrices();
				await setTimeoutPromise(this.fetchDelay, 'waiting is done'); // spread over 20 minutes for API rate limit (400 / min)
				await this.fetchPrices();
			};
			this.homey.on('everyhour', this.eventListenerHour);

			// fetch prices now
			await this.fetchPrices();
			await this.handlePrices();

			this.log(`${this.getName()} has been initialized`);
		} catch (error) {
			this.error(error);
			// this.setUnavailable(error.message).catch(this.error);
			this.restartDevice(1 * 60 * 1000); // restart after 1 minute
		}
	}

	async restartDevice(delay) {
		if (this.restarting) return;
		this.restarting = true;
		this.destroyListeners();
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
	async onSettings({ newSettings }) { // , oldSettings, changedKeys) {
		this.log(`${this.getName()} device settings changed by user`, newSettings);
		this.restartDevice(500);
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

	async fetchPrices() {
		try {
			this.log('fetching prices of today and tomorrow (when available)');
			const prices = await this.dap.getPrices()
				.catch(async (error) => {
					this.log('Error fetching prices. Trying again in 10 minutes', error.message);
					await setTimeoutPromise(10 * 60 * 1000, 'waiting is done');
					return this.dap.getPrices();
				});
			if (!prices[0]) throw Error('something went wrong fetching prices');
			if (!this.prices || this.prices.length < 1) {
				this.prices = [];
				this.log(`${this.getName()} received first prices for today.`);
				if (prices.length === 2) this.log(`${this.getName()} received first prices for tomorrow.`);
			}
			if (prices[0].prices.length !== 24) this.log(`${this.getName()} did not receive 24 hours of prices for today`);
			if (this.prices.length === 1 && prices.length === 2) this.log(`${this.getName()} received new prices for tomorrow.`);
			if (prices[1] && prices[1].prices.length !== 24) this.log(`${this.getName()} did not receive 24 hours of prices for tomorrow`);
			this.prices = prices;
		} catch (error) {
			this.error(error);
		}
	}

	// add markUp and convert from mWh>kWh
	async markUpPrices(array) {
		return array.map((price) => {
			const muPrice = (((price * (1 + this.settings.variableMarkup / 100)) / 1000) + this.settings.fixedMarkup) * this.settings.exchangeRate;
			return muPrice;
		});
	}

	async handlePrices() {
		try {
			if (!this.prices || !this.prices[0]) throw Error('no price info available');

			// get the present hour (0 - 23)
			const now = new Date();
			const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
			const H0 = nowLocal.getHours();

			// Array pricesThisDay with markUp
			const pricesThisDay = await this.markUpPrices(this.prices[0].prices);
			const priceThisDayAvg = average(pricesThisDay);

			// Array pricesNext8h with markUp
			let pricesNext8h = this.prices[0].prices.slice(H0, H0 + 8);
			if (pricesNext8h.length < 8) {
				if (!this.prices[1]) throw Error('Next 8 hour prices are not available');
				pricesNext8h = pricesNext8h.concat(this.prices[1].prices.slice(0, 8 - pricesNext8h.length));

			}
			pricesNext8h = await this.markUpPrices(pricesNext8h);
			const priceNext8hAvg = average(pricesNext8h);
			const priceNow = pricesNext8h[0];

			// set capabilities
			await this.setCapability('meter_price_this_day_avg', priceThisDayAvg);
			await this.setCapability('meter_price_next_8h_avg', priceNext8hAvg);
			pricesNext8h.forEach(async (price, index) => {
				await this.setCapability(`meter_price_h${index}`, price).catch(this.error);
			});

			// send tariff to power or gas driver
			let sendTo = 'set_tariff_power';
			if (this.settings.biddingZone === 'TTF_EOD') sendTo = 'set_tariff_gas';
			if (this.settings.sendTariff) this.homey.emit(sendTo, { tariff: priceNow });

			// trigger flow cards
			const tokens = { meter_price_h0: pricesNext8h[0] };
			const state = { priceNow, this_day: priceThisDayAvg, next_8h: priceNext8hAvg };
			this.homey.app.triggerPriceBelowAvg(this, tokens, state);
			this.homey.app.triggerPriceAboveAvg(this, tokens, state);

		} catch (error) {
			this.error(error);
		}
	}

}

module.exports = MyDevice;
