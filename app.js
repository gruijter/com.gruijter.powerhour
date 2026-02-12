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

class MyApp extends Homey.App {

  async onInit() {
    try {
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
          setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timeout')), 10000);
        }),
      ]);
      this.log('HomeyAPI connected');
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

  async startWebHookListener() {
    const id = Homey.env.WEBHOOK_ID;
    const secret = Homey.env.WEBHOOK_SECRET;
    const data = {
      $keys: ['pbth-entsoe-bridge'], // appId is required in query
    };
    this.webhook = await this.homey.cloud.createWebhook(id, secret, data);
    this.webhook.on('message', async (args) => {
      this.log('Got a webhook message!');
      try {
        const { body } = args;
        if (body && body.event === 'price_update' && body.zone && body.data) {
          this.log('Received price update for zone:', body.zone);
          Promise.all(['dap', 'dap15'].map(async (driverId) => {
            const driver = await this.homey.drivers.getDriver(driverId).catch(() => null);
            if (driver && driver.handlePriceUpdate) {
              await driver.handlePriceUpdate(body.zone, body.data);
            }
          })).catch((err) => this.error('Error processing price update:', err));
        }
      } catch (err) {
        this.error('Error handling webhook message', err);
      }
    });
  }

  everyHour() {
    this.scheduleNextHour();
    this.log('everyHour job started');
  }

  scheduleNextHour() {
    if (this.everyHourId) this.homey.clearTimeout(this.everyHourId);
    const now = new Date();
    const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 2000);
    const delay = nextHour - now;

    this.everyHourId = this.homey.setTimeout(() => {
      try {
        this.homey.emit('everyhour_PBTH', true);
      } catch (error) {
        this.error(error);
      }
      this.scheduleNextHour();
    }, delay);
  }

  everyXminutes(interval = 15) {
    this.scheduleNextXminutes(interval);
    this.log('every15m job started');
  }

  scheduleNextXminutes(interval) {
    if (this.everyXMinutesId) this.homey.clearTimeout(this.everyXMinutesId);
    const now = new Date();
    const currentMinutes = now.getMinutes();
    const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
    const nextXminutes = new Date(now);
    nextXminutes.setMinutes(nextMultipleOfX, 0, 2000);
    const delay = nextXminutes - now;

    this.everyXMinutesId = this.homey.setTimeout(() => {
      const currentNow = new Date();
      // Only emit if not on a full hour (handled by everyHour)
      if (currentNow.getMinutes() !== 0) {
        try {
          this.homey.emit('every15m_PBTH', true);
        } catch (error) {
          this.error(error);
        }
      }
      this.scheduleNextXminutes(interval);
    }, delay);
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
