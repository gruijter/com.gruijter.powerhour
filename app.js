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

		this._priceLowestAvg = this.homey.flow.getDeviceTriggerCard('price_lowest_avg');
		this._priceLowestAvg.registerRunListener(async (args, state) => {
			// args.period: 8 or this_day  // args.hours: 2, 3, 4, 5 or 6
			let prices = [...state.pricesThisDay];
			if (args.period !== 'this_day') prices = [...state.pricesNext8h];

			// calculate all avg prices for x hour periods
			const avgPrices = [];
			prices.forEach((price, index) => {
				if (index > prices.length - args.hours) return;
				const hours = prices.slice(index, index + args.hours);
				const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
				avgPrices.push(avgPrice);
			});
			const minAvgPrice = Math.min(...avgPrices);
			return avgPrices[0] <= minAvgPrice;
		});
		this.triggerPriceLowestAvg = (device, tokens, state) => {
			this._priceLowestAvg
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
