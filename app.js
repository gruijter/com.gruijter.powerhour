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
const TimeHelpers = require('./lib/helpers/TimeHelpers');
const PriceDrivers = require('./lib/helpers/PriceDrivers');
const MigrationNotice = require('./lib/helpers/MigrationNotice');
const MemLog = require('./lib/helpers/MemLog');
const CrashNotice = require('./lib/helpers/CrashNotice');

class MyApp extends Homey.App {

  async onInit() {
    if (Homey.env.PBTH_INSPECT === '1') require('inspector').open(9222, '0.0.0.0', false); // TEMP
    this.memLog = new MemLog(this); this.memLog.start();
    this.crashNotice = new CrashNotice(this);
    this.crashNotice.start();
    try {
      this.registerFlowListeners();
      await this.initApi();

      this.homey.setMaxListeners(100);
      this.everyHour();
      this.everyXminutes(15);
      this.retry(5);
      this.migrationNotice = new MigrationNotice(this.homey);
      this.migrationNotice.start();

      this.log(`Power by the Hour app is running... Timezone: ${this.homey.clock.getTimezone()}`);
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('app onUninit called');
    if (this.memLog) this.memLog.stop();
    if (this.migrationNotice) this.migrationNotice.stop();
    if (this.crashNotice) this.crashNotice.stop();
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
    this.homey.removeAllListeners('price_source_removed_PBTH');
  }

  // One fetch per key and local day, shared by all devices. An empty or partial ({ partial: true })
  // result is not kept: the caller retries later.
  getSharedDaily(key, day, fetch) {
    if (!this.sharedDaily || this.sharedDaily.day !== day) this.sharedDaily = { day, values: new Map() };
    const { values } = this.sharedDaily;
    if (!values.has(key)) {
      values.set(key, fetch().catch(() => null).then((value) => {
        if (value == null || value.partial) values.delete(key);
        return value;
      }));
    }
    return values.get(key);
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
      this.apiRetryId = this.homey.setTimeout(() => {
        this.initApi().catch((error) => this.error(error));
      }, 60000);
    }
  }

  // The new price slot's tariff on every consumer device, once per boundary (the first caller runs
  // it, one driver after the other). Price devices fire their period triggers after it, so a flow on
  // that trigger reads the new meter_tariff (generic_price_driver).
  slotTariffs() {
    const slot = TimeHelpers.startOfLocalBlock(Date.now(), 15, this.homey.clock.getTimezone());
    if (!this.slotTariffRun || this.slotTariffRun.slot !== slot) {
      const done = (async () => {
        for (const driver of Object.values(this.homey.drivers.getDrivers())) {
          if (typeof driver.priceSlotTick === 'function') await driver.priceSlotTick().catch((err) => this.error(err));
        }
      })();
      this.slotTariffRun = { slot, done };
    }
    return this.slotTariffRun.done;
  }

  everyHour() {
    this.scheduleNextHour();
    this.log('everyHour job started');
  }

  scheduleNextHour() {
    if (this.everyHourId) this.homey.clearTimeout(this.everyHourId);
    // The local hour: the process clock runs in UTC, and in a half-hour-offset zone the UTC hour
    // starts at local :30.
    const nowMs = Date.now();
    const nextHour = TimeHelpers.startOfLocalBlock(nowMs, 60, this.homey.clock.getTimezone()) + (60 * 60 * 1000) + 10;
    const delay = nextHour - nowMs;

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
    const nowMs = Date.now();
    const tz = this.homey.clock.getTimezone();
    const nextXminutes = TimeHelpers.startOfLocalBlock(nowMs, interval, tz) + (interval * 60 * 1000) + 10;
    const delay = nextXminutes - nowMs;

    this.everyXMinutesId = this.homey.setTimeout(() => {
      // Only emit if not on a full local hour (handled by everyHour)
      if (TimeHelpers.toLocalDate(new Date(), tz).getMinutes() !== 0) {
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
    this.retryId = this.homey.setInterval(() => {
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
   * Build the normalized prices payload for the inter-app API.
   * Includes all future slots (from the current period onwards) for every
   * configured price device (PriceDrivers.DRIVER_IDS) that has valid prices.
   *
   * @returns {object} payload  { generatedAt, prices: [...] }
   */
  getPricesPayload() {
    const now = new Date();
    const priceEntries = PriceDrivers.getDevices(this.homey)
      .map((device) => (device.pricesPayloadEntry ? device.pricesPayloadEntry(now) : null))
      .filter(Boolean);

    return {
      generatedAt: now.toISOString(),
      prices: priceEntries,
    };
  }

}

module.exports = MyApp;
