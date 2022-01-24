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

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');

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
					this.homey.removeAllListeners('everyhour').catch(() => null);
					// Homey.ManagerCron.unregisterTask('everyhour').catch(() => null);
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

	}

}

module.exports = MyApp;
