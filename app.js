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

/**
 * TIME HANDLING DOCUMENTATION
 *
 * Homey Environment (Intended Runtime):
 * - Homey runs its internal clock in UTC.
 * - `new Date()` returns the current time in UTC.
 * - Local time calculations (e.g. start of day) depend on the Homey's configured location/timezone.
 * - The app uses `TimeHelpers.getUTCPeriods(timeZone)` to calculate the UTC start/end timestamps
 *   for "Today", "Tomorrow", etc., from the Homey's location based local timezone.
 */

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const Flows = require('./lib/flows/Flows');

class MyApp extends Homey.App {

  async onInit() {
    try {
      this.registerFlowListeners();
      await this.initApi();

      // start polling every whole hour, 15 minutes and retry missing source devices every 5 minutes
      this.homey.setMaxListeners(100);
      this.everyHour();
      this.everyXminutes(15);
      this.retry(5);
      this.startPerformanceMonitor();

      this.log(`Power by the Hour app is running... Timezone: ${this.homey.clock.getTimezone()}`);
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('app onUninit called');
    if (this.perfInterval) this.homey.clearInterval(this.perfInterval);
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
  }

  startPerformanceMonitor() {
    let peakHeapUsed = 0;
    let peakPhysical = 0;

    this.perfInterval = this.homey.setInterval(() => {
      try {
        // eslint-disable-next-line global-require
        const v8 = require('v8');
        const stats = v8.getHeapStatistics();
        const heapUsedMb = Math.round((stats.used_heap_size / 1024 / 1024) * 100) / 100;
        const heapTotalMb = Math.round((stats.total_heap_size / 1024 / 1024) * 100) / 100;
        const physicalMb = Math.round((stats.total_physical_size / 1024 / 1024) * 100) / 100;

        if (heapUsedMb > peakHeapUsed) peakHeapUsed = heapUsedMb;
        if (physicalMb > peakPhysical) peakPhysical = physicalMb;

        const logMsg = `[PERF TELEMETRY] HeapUsed: ${heapUsedMb}MB (Peak: ${peakHeapUsed}MB) `
          + `| HeapTotal: ${heapTotalMb}MB | Physical: ${physicalMb}MB (Peak: ${peakPhysical}MB)`;
        this.log(logMsg);
      } catch (err) {
        this.error('[PERF TELEMETRY ERROR]', err);
      }
    }, 60000);
  }

  async initApi() {
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
    try {
      this.api = await Promise.race([
        HomeyAPI.createAppAPI({ homey: this.homey }),
        new Promise((resolve, reject) => {
          this.homey.setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timeout')), 10000);
        }),
      ]);
      this.log('HomeyAPI connected');
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

  everyHour() {
    this.scheduleNextHour();
    this.log('everyHour job started');
  }

  scheduleNextHour() {
    if (this.everyHourId) this.homey.clearTimeout(this.everyHourId);
    const now = new Date();
    const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 10);
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
    nextXminutes.setMinutes(nextMultipleOfX, 0, 10);
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

  /**
   * Build the normalized DAP prices payload for the inter-app API.
   * Includes all future slots (from the current period onwards) for every
   * configured dap, dap15 and dapg device that has valid prices.
   *
   * @returns {object} payload  { generatedAt, prices: [...] }
   */
  getDapPricesPayload() {
    const DAP_DRIVER_IDS = ['dap', 'dap15', 'dapg'];
    const priceEntries = [];
    const now = new Date();

    DAP_DRIVER_IDS.forEach((driverId) => {
      let driver;
      try {
        driver = this.homey.drivers.getDriver(driverId);
      } catch (e) {
        return; // driver not loaded (e.g. no dapg devices paired)
      }

      const devices = driver.getDevices();
      devices.forEach((device) => {
        if (!device.prices || !device.prices[0] || !device.prices[0].time) return;

        const settings = device.settings || device.getSettings();
        const priceInterval = device.priceInterval || 60;

        // Only future slots (>= start of current period)
        const periodMs = priceInterval * 60 * 1000;
        const currentPeriodStart = new Date(Math.floor(now.getTime() / periodMs) * periodMs);

        const slots = device.prices
          .filter((p) => new Date(p.time) >= currentPeriodStart)
          .sort((a, b) => new Date(a.time) - new Date(b.time))
          .map((p) => ({
            time: new Date(p.time).toISOString(),
            importPrice: p.muPrice,
            exportPrice: p.exportPrice,
            isForecast: p.isForecast || false,
          }));

        if (slots.length === 0) return;

        priceEntries.push({
          deviceId: device.getData().id,
          deviceName: device.getName(),
          driverType: driverId,
          biddingZone: settings.biddingZone || '',
          currency: settings.currency || '€',
          priceInterval,
          slots,
        });
      });
    });

    return {
      generatedAt: now.toISOString(),
      prices: priceEntries,
    };
  }

}

module.exports = MyApp;
