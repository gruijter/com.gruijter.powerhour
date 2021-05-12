/* eslint-disable camelcase */
/* eslint-disable import/no-extraneous-dependencies */
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

class MyApp extends Homey.App {

	async onInit() {
		this.log('Power by the Hour app is running...');
		// register some listeners
		process.on('unhandledRejection', (error) => {
			this.error('unhandledRejection! ', error);
		});
		process.on('uncaughtException', (error) => {
			this.error('uncaughtException! ', error);
		});
		Homey
			.on('unload', () => {
				this.log('app unload called');
				Homey.removeAllListeners('everyhour').catch(() => null);
				Homey.ManagerCron.unregisterTask('everyhour').catch(() => null);
			})
			.on('memwarn', () => {
				this.log('memwarn!');
			});
		// // do garbage collection every 10 minutes
		// this.intervalIdGc = setInterval(() => {
		// 	global.gc();
		// }, 1000 * 60 * 10);

		// add CRON task to update device state every hour
		// await Homey.ManagerCron.unregisterTask('everyhour').catch(() => null);
		// await Homey.ManagerCron.registerTask('everyhour', '0 0 * * * *').catch(this.error);
		await Homey.ManagerCron.registerTask('everyhour', '0 0 * * * *')
			.then(() => this.log('cron task added'))
			.catch(() => this.log('cron task already exists'));
		const everyHour = await Homey.ManagerCron.getTask('everyhour');
		everyHour.on('run', () => {
			Homey.emit('everyhour', true);
		});
	}

}

module.exports = MyApp;
