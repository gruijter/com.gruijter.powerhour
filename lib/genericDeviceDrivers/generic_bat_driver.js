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

const { Driver } = require('homey');
const crypto = require('crypto');
const SourceDeviceHelper = require('../helpers/SourceDeviceHelper');
const { setTimeoutPromise, runExclusive } = require('../helpers/Util');
const PriceIntervalGroups = require('../helpers/PriceIntervalGroups');
const PairSetup = require('../helpers/PairSetup');

class BatDriver extends Driver {

  async onInit() {
    await super.onInit().catch(this.error);

    this.registerHourlyListener();
    this.register15mListener();
    this.registerRetryListener();
    this.registerTariffListener();
  }

  async onUninit() {
    this.isDestroyed = true;

    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);
    if (this.eventListenerTariff) this.homey.removeListener('set_tariff_power_PBTH', this.eventListenerTariff);

    await setTimeoutPromise(3000, this);
  }

  registerHourlyListener() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);

    this.eventListenerHour = () => {
      (async () => {
        try {
          // Every driver type (power/grid/solar/gas/water/battery/evCharger) listens on this same
          // app-wide event independently, so without a stagger they all start their own
          // (already-staggered-per-device) update loop in the same instant - a thundering-herd
          // burst of Insights fetches/chart rebuilds/ROI-strategy solves that has been observed
          // to intermittently push the process over Homey's memory ceiling. A random jitter here
          // spreads driver types apart on every firing.
          await setTimeoutPromise(Math.random() * 8000, this);
          const devices = await this.getDevices();
          for (const device of devices) {
            await this.checkAndPollDevice(device);
            await setTimeoutPromise(500, this);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on('everyhour_PBTH', this.eventListenerHour);
  }

  register15mListener() {
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);

    this.eventListener15m = () => {
      (async () => {
        try {
          // See registerHourlyListener() above for why this jitter exists.
          await setTimeoutPromise(Math.random() * 8000, this);
          const devices = await this.getDevices();
          for (const device of devices) {
            if (device.priceInterval === 15) {
              await this.checkAndPollDevice(device);
              await setTimeoutPromise(500, this);
            }
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on('every15m_PBTH', this.eventListener15m);
  }

  async checkAndPollDevice(device) {
    // A device still in onInit (or whose init failed) has no state to poll yet: onInit polls
    // itself when done, and checkDeviceHealth() restarts a failed one.
    if (!device.initReady || device.migrating || device.restarting) return;
    const deviceName = device.getName();
    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch {
      this.error(`Source device ${deviceName} is missing.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retry')).catch((err) => this.error(err));
      device.restartDevice(10 * 60 * 1000).catch((err) => this.error(err)); // restart after 10 minutes
      return;
    }

    try {
      await device.poll();
      await device.setAvailable().catch((err) => this.error(err));
    } catch (error) {
      this.error(`Error polling device ${deviceName}:`, error);
    }
  }

  registerRetryListener() {
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);

    this.eventListenerRetry = () => {
      (async () => {
        try {
          const devices = await this.getDevices();
          for (const device of devices) {
            await this.checkDeviceHealth(device);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on('retry_PBTH', this.eventListenerRetry);
  }

  async checkDeviceHealth(device) {
    if (device.migrating || device.restarting) return;

    const deviceName = device.getName();
    if (!device.initReady) {
      this.log(`${deviceName} Restarting now (Init not ready)`);
      device.restartDevice(5000 + Math.random() * 20000).catch((err) => this.error(err));
    }

    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch((err) => this.error(err));
    }
  }

  // Extracted from the 'set_tariff_power_PBTH' event listener so it can also be awaited directly
  // by a flow action card (Flows.js) - the event-based path below is fire-and-forget (fine for
  // DAP's own automatic hourly broadcast, nothing waits on it), but a flow's "Set Tariff" action
  // card needs the real completion signal so a following card in the same flow doesn't race
  // against tariffs still being written to devices.
  // Serialised per driver - see the note on generic_sum_driver's applyTariffFromEvent(). Here a
  // driver-wide key is not merely for consistency but required: the device loop below iterates
  // EVERY device, not just the broadcast group's, so two overlapping runs would write the same
  // device concurrently whatever their groups.
  async applyTariffFromEvent(args) {
    return runExclusive(`tariff|${this.id}`, () => this.applyTariffFromEventExclusive(args));
  }

  async applyTariffFromEventExclusive(args) {
    const eventName = 'set_tariff_power_PBTH';
    let { pricesNextHours } = args;
    let { exportPricesNextHours } = args;

    // Support for manual tariff update via flow action card
    if (!pricesNextHours || !pricesNextHours[0]) {
      if (args.tariff !== undefined && args.tariff !== null) {
        pricesNextHours = [Number(args.tariff)];
        exportPricesNextHours = args.exportTariff !== undefined && args.exportTariff !== null ? [Number(args.exportTariff)] : pricesNextHours;
      } else {
        this.log('no prices next hours found');
        return;
      }
    }

    const group = args.group || 1;

    this.log(`${eventName} received from flow or DAP for group ${group}. Tariff: ${pricesNextHours[0]}`);

    this.pricesNextHours = this.pricesNextHours || {};
    this.exportPricesNextHours = this.exportPricesNextHours || {};
    this.pricesNextHoursMarketLength = this.pricesNextHoursMarketLength || {};
    this.pricesNextHoursIsForecast = this.pricesNextHoursIsForecast || {};
    this.priceIntervals = this.priceIntervals || {};
    this.currencies = this.currencies || {};

    this.pricesNextHours[group] = pricesNextHours;
    this.exportPricesNextHours[group] = exportPricesNextHours || pricesNextHours;
    this.pricesNextHoursIsForecast[group] = args.pricesNextHoursIsForecast;
    this.pricesNextHoursMarketLength[group] = args.pricesNextHoursMarketLength || 1;
    // Finest declared interval wins for the group, instead of last-write-wins. A flow's action
    // card declares no interval at all and therefore no longer votes for 60 by omission.
    // See lib/helpers/PriceIntervalGroups.js.
    this.priceIntervals[group] = await PriceIntervalGroups.applyFor(this.homey, {
      channel: eventName,
      group,
      sourceId: args.sourceDeviceId,
      sourceName: args.sourceDeviceName,
      interval: args.priceInterval,
    });
    this.currencies[group] = args.currency;

    // Wait 2 seconds not to stress Homey and prevent race issues
    await setTimeoutPromise(2 * 1000, this);

    const devices = await this.getDevices();
    let deviceIndex = 0;
    for (const device of devices) {
      if (deviceIndex > 0) {
        await setTimeoutPromise(50, this);
      }
      deviceIndex += 1;
      // ...Exclusive: we already hold this driver's tariff queue - going through the public
      // setPricesDevice() here would deadlock against our own lock.
      await this.setPricesDeviceExclusive(device);
    }
  }

  registerTariffListener() {
    const eventName = 'set_tariff_power_PBTH';
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);

    this.eventListenerTariff = (args) => {
      this.applyTariffFromEvent(args).catch((err) => this.error(err));
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  // Shares applyTariffFromEvent()'s queue - see updateDeviceTariff() in generic_sum_driver.js.
  async setPricesDevice(device, overrideGroup) {
    return runExclusive(`tariff|${this.id}`, () => this.setPricesDeviceExclusive(device, overrideGroup));
  }

  async setPricesDeviceExclusive(device, overrideGroup) {
    const deviceName = device.getName();
    const updateGroup = overrideGroup || device.getSettings().tariff_update_group;

    if (!updateGroup || !this.pricesNextHours || !this.pricesNextHours[updateGroup]) {
      this.log('No prices available for group', updateGroup, deviceName);
      await device.updatePrices(null);
      return;
    }

    const priceInterval = this.priceIntervals[updateGroup] || 60;
    const pricesNextHours = this.pricesNextHours[updateGroup];
    const exportPricesNextHours = (this.exportPricesNextHours && this.exportPricesNextHours[updateGroup]) || pricesNextHours;
    const pricesNextHoursMarketLength = this.pricesNextHoursMarketLength[updateGroup];
    const pricesNextHoursIsForecast = this.pricesNextHoursIsForecast[updateGroup];
    const currency = this.currencies ? this.currencies[updateGroup] : undefined;
    await device.updatePrices([...pricesNextHours], [...exportPricesNextHours], pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast, currency);
  }

  // With ds.setup the setup view follows the list (see lib/helpers/PairSetup.js).
  onPair(session) {
    if (this.ds.setup) PairSetup.registerPair(this, session, () => this.onPairListDevices());
    else session.setHandler('list_devices', () => this.onPairListDevices());
  }

  async onRepair(session, device) {
    PairSetup.registerRepair(this, session, device, () => this.onPairListDevices(), this.sourceSettingIds());
  }

  // The settings that come with a listed source device.
  sourceSettingIds() {
    return ['homey_device_id', 'homey_device_name'];
  }

  // The capability list for these settings: paired with it, and kept on it by the device's migration.
  capabilitiesFor(settings = {}) {
    let caps = [...this.ds.deviceCapabilities];
    // Budget targets only with a budget.
    if (!settings.distribution || settings.distribution === 'NONE') caps = caps.filter((cap) => !cap.includes('meter_target'));
    if (settings.roiEnable) caps.push('roi_duration');
    return caps;
  }

  async onPairListDevices() {
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch {
        // ignore
      }
      if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
      this.log('listing of devices started');
      const randomId = crypto.randomBytes(3).toString('hex');
      const devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
      if (!allDevices) return [];

      const keys = Object.keys(allDevices);
      const listed = []; // { device, score }: see PairSetup.listScore()

      keys.forEach((key) => {
        const homeyDevice = allDevices[key];
        const compatibility = this.checkDeviceCompatibility(homeyDevice);

        if (compatibility.found) {
          const device = {
            name: `${homeyDevice.name}_Σ`,
            data: {
              id: `PH_${this.ds.driverId}_${homeyDevice.id}_${randomId}`,
            },
            settings: this.getDeviceSettings(homeyDevice),
          };
          if (compatibility.useMeasureSource) {
            device.settings.use_measure_source = true;
          }
          device.capabilities = this.capabilitiesFor(device.settings);
          if (compatibility.needsMapping) device.name += ` (${this.homey.__('repair.setup_map_manually')})`;
          listed.push({ device, score: PairSetup.listScore(this, homeyDevice, compatibility) });
        }
      });

      devices.push(...PairSetup.sortByScore(listed));
      return devices;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  checkDeviceCompatibility(homeyDevice) {
    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    return {
      homey_device_id: homeyDevice.id,
      homey_device_name: homeyDevice.name,
      level: this.homey.app.manifest.version,
      tariff_update_group: 1,
    };
  }

}

module.exports = BatDriver;
