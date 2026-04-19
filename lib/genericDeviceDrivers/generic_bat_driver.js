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
const SourceDeviceHelper = require('../SourceDeviceHelper');
const { setTimeoutPromise } = require('../Util');

class BatDriver extends Driver {

  async onInit() {
    this.log('onInit');
    await super.onInit().catch(this.error);

    // Add listener for hourly trigger
    this.registerHourlyListener();

    // Add listener for 15m trigger
    this.register15mListener();

    // Add listener for retry logic
    this.registerRetryListener();

    // Add listener for new prices
    this.registerTariffListener();
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log('bat driver onUninit called');

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
          const devices = await this.getDevices();
          await Promise.all(devices.map((device) => this.checkAndPollDevice(device)));
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
          const devices = await this.getDevices();
          await Promise.all(devices.map((device) => {
            if (device.priceInterval === 15) return this.checkAndPollDevice(device);
            return Promise.resolve();
          }));
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on('every15m_PBTH', this.eventListener15m);
  }

  async checkAndPollDevice(device) {
    const deviceName = device.getName();
    // Check if source device exists for HOMEY-API device
    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch (error) {
      this.error(`Source device ${deviceName} is missing.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retry')).catch((err) => this.error(err));
      device.restartDevice(10 * 60 * 1000).catch((err) => this.error(err)); // restart after 10 minutes
      return;
    }

    // Poll all capabilities
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

    // Check if source device exists
    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch (error) {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch((err) => this.error(err));
    }
  }

  registerTariffListener() {
    const eventName = 'set_tariff_power_PBTH';
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);

    this.eventListenerTariff = (args) => {
      (async () => {
        try {
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
          this.priceIntervals[group] = args.priceInterval || 60;
          this.currencies[group] = args.currency;

          // Wait 2 seconds not to stress Homey and prevent race issues
          await setTimeoutPromise(2 * 1000, this);

          const devices = await this.getDevices();
          for (const device of devices) {
            await this.setPricesDevice(device);
            await setTimeoutPromise(500, this); // Yield to event loop
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  async setPricesDevice(device, overrideGroup) {
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

    this.log('updating prices', deviceName, pricesNextHours[0], pricesNextHoursMarketLength);
    await device.updatePrices([...pricesNextHours], [...exportPricesNextHours], pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast, currency);
  }

  async onRepair(session, device) {
    this.log('Repairing of device started', device.getName());
    let selectedDevices = [];
    session.setHandler('list_devices', () => this.onPairListDevices());
    session.setHandler('list_devices_selection', (devices) => {
      selectedDevices = devices;
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'loading') {
        const [dev] = selectedDevices;
        if (!dev || !dev.settings) {
          await session.showView('done');
          throw Error(this.homey.__('error_device_corrupt'));
        }
        const newSettings = {
          homey_device_id: dev.settings.homey_device_id,
          homey_device_name: dev.settings.homey_device_name,
        };
        this.log('old settings:', device.getSettings());
        await device.setSettings(newSettings).catch((err) => this.error(err));
        await session.showView('done');
        this.log('new settings:', device.getSettings());
        device.restartDevice().catch((err) => this.error(err));
      }
    });
    session.setHandler('disconnect', () => {
      this.log('Repairing of device ended', device.getName());
    });
  }

  // Stuff to find Homey battery devices
  async onPairListDevices() {
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) {
        // ignore
      }
      if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
      this.log('listing of devices started');
      const randomId = crypto.randomBytes(3).toString('hex');
      const devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
      if (!allDevices) return [];

      const keys = Object.keys(allDevices);
      const allCaps = [...this.ds.deviceCapabilities];
      const caps = this.getDeviceCapabilities ? this.getDeviceCapabilities() : allCaps;

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
            capabilities: caps,
          };
          if (compatibility.useMeasureSource) {
            device.settings.use_measure_source = true;
          }
          devices.push(device);
        }
      });

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
