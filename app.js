/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

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
const { HomeyAPI } = require('homey-api');
const Flows = require('./lib/Flows');

// require('inspector').open(9229, '0.0.0.0', false);

class MyApp extends Homey.App {

  async onInit() {
    try {
      // for debugging
      // if (process.env.DEBUG === '1') {
      //   try {
      //     require('inspector').waitForDebugger();
      //   }  catch (error) {
      //     require('inspector').open(9222, '0.0.0.0', true);
      //   }
      // }

      // register flows
      this.registerFlowListeners();

      // login to Homey API
      await this.initApi();

      // start polling every whole hour, 15 minutes and retry missing source devices every 5 minutes
      this.homey.setMaxListeners(300); // INCREASE LISTENERS
      this.everyHour();
      this.everyXminutes(15);
      this.retry(5);

      // start webhook listener
      await this.startWebHookListener();

      this.log('Power by the Hour app is running...');
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('app onUninit called');
    if (this.everyHourId) this.homey.clearTimeout(this.everyHourId);
    if (this.everyXMinutesId) this.homey.clearTimeout(this.everyXMinutesId);
    if (this.retryId) this.homey.clearInterval(this.retryId);
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);

    this.homey.removeAllListeners('everyhour_PBTH');
    this.homey.removeAllListeners('every15m_PBTH');
    this.homey.removeAllListeners('retry_PBTH');
    this.homey.removeAllListeners('set_tariff_power_PBTH');
    this.homey.removeAllListeners('set_tariff_gas_PBTH');
    this.homey.removeAllListeners('set_tariff_water_PBTH');
    if (this.webhook) {
      await this.webhook.unregister().catch((err) => this.error(err));
    }
  }

  async initApi() {
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
    try {
      this.api = await Promise.race([
        HomeyAPI.createAppAPI({ homey: this.homey }),
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timeout')), 25000);
        }),
      ]);
      this.log('HomeyAPI connected');
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

  // {
  //   event: 'price_update',
  //   zone: '10YCH-SWISSGRIDZ',
  //   name: 'Switzerland',
  //   updated: '2026-01-30T11:10:06.263Z',
  //   data: [
  //     { time: '2026-01-28T12:00:00.000Z', price: 160.94 },
  //     { time: '2026-01-28T13:00:00.000Z', price: 161.78 },
  async startWebHookListener() {
    const id = Homey.env.WEBHOOK_ID; // "56db7fb12dcf75604ea7977d"
    const secret = Homey.env.WEBHOOK_SECRET; // "2uhf83h83h4gg34..."
    const data = {
      // Provide unique properties for this Homey here
      $keys: ['pbth-entsoe-bridge'], // appId is required in query
    };
    this.webhook = await this.homey.cloud.createWebhook(id, secret, data);
    this.webhook.on('message', async (args) => {
      this.log('Got a webhook message!');
      // this.log('headers:', args.headers);
      // this.log('query:', args.query);
      // console.dir(args.body, { depth: null });
      try {
        const { body } = args;
        if (body && body.event === 'price_update' && body.zone && body.data) {
          this.log('Received price update for zone:', body.zone);
          const drivers = ['dap', 'dap15'];
          for (const driverId of drivers) {
            const driver = await this.homey.drivers.getDriver(driverId).catch(() => null);
            if (driver && driver.handlePriceUpdate) {
              await driver.handlePriceUpdate(body.zone, body.data);
            }
          }
        }
      } catch (err) {
        this.error('Error handling webhook message', err);
      }
    });
  }

  everyHour() {
    const scheduleNextHour = () => {
      if (this.everyHourId) this.homey.clearTimeout(this.everyHourId); // Clear any existing timeout
      const now = new Date();
      const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 2000);
      const timeToNextHour = nextHour - now;
      // console.log('everyHour starts in', timeToNextHour / 1000);
      this.everyHourId = this.homey.setTimeout(() => {
        try {
          this.homey.emit('everyhour_PBTH', true);
        } catch (error) {
          this.error(error);
        }
        scheduleNextHour(); // Schedule the next hour
      }, timeToNextHour);
    };
    scheduleNextHour();
    this.log('everyHour job started');
  }

  everyXminutes(interval = 15) {
    const scheduleNextXminutes = () => {
      if (this.everyXMinutesId) this.homey.clearTimeout(this.everyXMinutesId); // Clear any existing timeout
      let now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 2000);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      this.everyXMinutesId = this.homey.setTimeout(() => {
        // Only emit if not on a full hour
        now = new Date();
        if (now.getMinutes() !== 0) {
          try {
            this.homey.emit('every15m_PBTH', true);
          } catch (error) {
            this.error(error);
          }
        }
        scheduleNextXminutes(); // Schedule the next X minutes
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('every15m job started');
  }

  retry(interval = 5) {
    if (this.retryId) this.homey.clearInterval(this.retryId);
    this.retryId = this.homey.setInterval(async () => {
      try {
        this.homey.emit('retry_PBTH', true);
      } catch (error) {
        this.error(error);
      }
    }, interval * 60 * 1000);
    this.log('retry job started');
  }

  registerFlowListeners() {
    const flows = new Flows(this);
    flows.register();
  }

}

module.exports = MyApp;
