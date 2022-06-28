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

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');

// require('inspector').open(9229, '0.0.0.0', false);

class MyApp extends Homey.App {

	async onInit() {
		try {
			// register some listeners
			process.on('unhandledRejection', (error) => {
				this.error('unhandledRejection! ', error);
			});
			process.on('uncaughtException', (error) => {
				this.error('uncaughtException! ', error);
			});
			this.homey
				.on('unload', () => {
					this.log('app unload called');
					this.homey.removeAllListeners('everyhour');
					this.homey.removeAllListeners('set_tariff_power');
					this.homey.removeAllListeners('set_tariff_gas');
					this.homey.removeAllListeners('set_tariff_water');
				})
				.on('memwarn', () => {
					this.log('memwarn!');
				});
			// // do garbage collection every 10 minutes
			// this.intervalIdGc = setInterval(() => {
			// 	global.gc();
			// }, 1000 * 60 * 10);

			// login to Homey API
			this.api = new HomeyAPIApp({ homey: this.homey });

			// start polling every whole hour
			this.everyHour();

			// register flows
			this.registerFlowListeners();

			this.log('Power by the Hour app is running...');

		} catch (error) { this.error(error); }
	}

	everyHour() {
		const now = new Date();
		const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 50);
		const timeToNextHour = nextHour - now;
		// console.log('everyHour starts in', timeToNextHour / 1000);
		this.homey.setTimeout(() => {
			this.homey.setInterval(async () => {
				this.homey.emit('everyhour', true);
			}, 60 * 60 * 1000);
			this.homey.emit('everyhour', true);
		}, timeToNextHour);
		this.log('everyHour job started');
	}

	registerFlowListeners() {

		const autoComplete = async (query, driverId) => {
			const driver = await this.homey.drivers.getDriver(driverId);
			const devices = driver.getDevices().filter((device) => device.settings.meter_via_flow);
			const devicesMap = devices.map((device) => (
				{
					name: device.getName(),
					id: device.getData().id,
				}
			));
			return devicesMap.filter((result) => result.name.toLowerCase().includes(query.toLowerCase()));
		};

		const runUpdateMeter = async (args, driverId) => {
			const driver = await this.homey.drivers.getDriver(driverId);
			const device = await driver.getDevice({ id: args.virtual_device.id });
			device.updateMeterFromFlow(args.value).catch(this.error);
		};

		// trigger cards
		this._priceLowest = this.homey.flow.getDeviceTriggerCard('price_lowest');
		this._priceLowest.registerRunListener(async (args, state) => {
			let minimum = Math.min(...state.pricesThisDay);
			if (args.period !== 'this_day') {
				minimum = Math.min(...state.pricesNext8h.slice(0, Number(args.period)));
			}
			return state.priceNow <= minimum;
		});
		this.triggerPriceLowest = (device, tokens, state) => {
			this._priceLowest
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceLowestToday = this.homey.flow.getDeviceTriggerCard('price_lowest_today');
		this._priceLowestToday.registerRunListener(async (args, state) => {
			// sort and select number of lowest prices
			const lowestNPrices = [...state.pricesThisDay].sort().slice(0, args.number);
			return state.priceNow <= Math.max(...lowestNPrices);
		});
		this.triggerPriceLowestToday = (device, tokens, state) => {
			this._priceLowestToday
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceLowestBefore = this.homey.flow.getDeviceTriggerCard('price_lowest_before');
		this._priceLowestBefore.registerRunListener(async (args, state) => {
			// calculate start and end hours compared to present hour
			const thisHour = state.H0; // e.g. 23 hrs
			let endHour = args.time; // e.g. 2 hrs
			if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
			let startHour = endHour - args.period; // e.g. 26 - 4 = 22 hrs

			// check if present hour is in scope op selected period
			if ((thisHour >= endHour) || (thisHour < startHour)) return false;

			// get period (2-8) hours pricing before end time
			let pricesPartYesterday = [];
			if (startHour < 0) {
				pricesPartYesterday = state.pricesYesterday.slice(startHour);
				startHour = 0;
			}
			let pricesPartTomorrow = [];
			if (endHour > 24) pricesPartTomorrow = state.pricesTomorrow.slice(0, endHour - 24);
			const pricesPartToday = state.pricesThisDay.slice(startHour, endHour);
			const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

			// sort and select number of lowest prices
			const lowestNPrices = pricesTotalPeriod.sort().slice(0, args.number);
			return state.priceNow <= Math.max(...lowestNPrices);
		});
		this.triggerPriceLowestBefore = (device, tokens, state) => {
			this._priceLowestBefore
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceHighest = this.homey.flow.getDeviceTriggerCard('price_highest');
		this._priceHighest.registerRunListener(async (args, state) => {
			let maximum = Math.max(...state.pricesThisDay);
			if (args.period !== 'this_day') {
				maximum = Math.max(...state.pricesNext8h.slice(0, Number(args.period)));
			}
			return state.priceNow >= maximum;
		});
		this.triggerPriceHighest = (device, tokens, state) => {
			this._priceHighest
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceLowestAvg = this.homey.flow.getDeviceTriggerCard('price_lowest_avg');
		this._priceLowestAvg.registerRunListener(async (args, state) => {
			// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
			let prices = [...state.pricesNext8h];

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
				prices = [...state.pricesThisDay];
				const avgPricesThisDay = [];
				prices.forEach((price, index) => {
					if (index > prices.length - Number(args.hours)) return;
					const hours = prices.slice(index, (index + Number(args.hours)));
					const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
					avgPricesThisDay.push(avgPrice);
				});
				minAvgPrice = Math.min(...avgPricesThisDay);
			}
			// console.log(`avg next ${args.hours} hrs: ${avgPricesNext8h[0]}, min avg for ${args.period}: ${minAvgPrice}`);
			return avgPricesNext8h[0] <= minAvgPrice;
		});
		this.triggerPriceLowestAvg = (device, tokens, state) => {
			this._priceLowestAvg
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceHighestAvg = this.homey.flow.getDeviceTriggerCard('price_highest_avg');
		this._priceHighestAvg.registerRunListener(async (args, state) => {
			// args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
			let prices = [...state.pricesNext8h];

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
				prices = [...state.pricesThisDay];
				const avgPricesThisDay = [];
				prices.forEach((price, index) => {
					if (index > prices.length - Number(args.hours)) return;
					const hours = prices.slice(index, (index + Number(args.hours)));
					const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
					avgPricesThisDay.push(avgPrice);
				});
				maxAvgPrice = Math.max(...avgPricesThisDay);
			}
			// console.log(`avg next ${args.hours} hrs: ${avgPricesNext8h[0]}, max avg for ${args.period}: ${maxAvgPrice}`);
			return avgPricesNext8h[0] >= maxAvgPrice;
		});
		this.triggerPriceHighestAvg = (device, tokens, state) => {
			this._priceHighestAvg
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceBelowAvg = this.homey.flow.getDeviceTriggerCard('price_below_avg');
		this._priceBelowAvg.registerRunListener(async (args, state) => {
			const percent = 100 * (1 - state.priceNow / state[args.period]);
			return percent >= Number(args.percent);
		});
		this.triggerPriceBelowAvg = (device, tokens, state) => {
			this._priceBelowAvg
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		this._priceAboveAvg = this.homey.flow.getDeviceTriggerCard('price_above_avg');
		this._priceAboveAvg.registerRunListener(async (args, state) => {
			const percent = 100 * (state.priceNow / state[args.period] - 1);
			return percent >= Number(args.percent);
		});
		this.triggerPriceAboveAvg = (device, tokens, state) => {
			this._priceAboveAvg
				.trigger(device, tokens, state)
				// .then(this.log(device.getName(), tokens))
				.catch(this.error);
		};

		// action cards
		const setTariffPower = this.homey.flow.getActionCard('set_tariff_power');
		setTariffPower
			.registerRunListener((args) => this.homey.emit('set_tariff_power', args));

		const setTariffGas = this.homey.flow.getActionCard('set_tariff_gas');
		setTariffGas
			.registerRunListener((args) => this.homey.emit('set_tariff_gas', args));

		const setTariffWater = this.homey.flow.getActionCard('set_tariff_water');
		setTariffWater
			.registerRunListener((args) => this.homey.emit('set_tariff_water', args));

		const setVariableMarkup = this.homey.flow.getActionCard('set_variable_markup');
		setVariableMarkup
			.registerRunListener((args) => args.device.setVariableMarkup(args.value).catch(this.error));

		const setFixedMarkup = this.homey.flow.getActionCard('set_fixed_markup');
		setFixedMarkup
			.registerRunListener((args) => args.device.setFixedMarkup(args.value).catch(this.error));

		const setExchangeRate = this.homey.flow.getActionCard('set_exchange_rate');
		setExchangeRate
			.registerRunListener((args) => args.device.setExchangeRate(args.value).catch(this.error));

		const minMaxReset = this.homey.flow.getActionCard('minmax_reset');
		minMaxReset
			.registerRunListener((args) => args.device.minMaxReset(true, 'flow').catch(this.error));

		const setMeterPower = this.homey.flow.getActionCard('set_meter_power');
		setMeterPower
			.registerRunListener((args) => runUpdateMeter(args, 'power').catch(this.error))
			.registerArgumentAutocompleteListener(
				'virtual_device',
				(query) => autoComplete(query, 'power').catch(this.error),
			);
		const setMeterGas = this.homey.flow.getActionCard('set_meter_gas');
		setMeterGas
			.registerRunListener((args) => runUpdateMeter(args, 'gas').catch(this.error))
			.registerArgumentAutocompleteListener(
				'virtual_device',
				async (query) => autoComplete(query, 'gas').catch(this.error),
			);

		const setMeterWater = this.homey.flow.getActionCard('set_meter_water');
		setMeterWater
			.registerRunListener((args) => runUpdateMeter(args, 'water').catch(this.error))
			.registerArgumentAutocompleteListener(
				'virtual_device',
				async (query) => autoComplete(query, 'water').catch(this.error),
			);

	}

}

module.exports = MyApp;
