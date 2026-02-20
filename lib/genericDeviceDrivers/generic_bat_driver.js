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
const nomXomStrategy = require('../strategies/NomXomStrategy');
const SourceDeviceHelper = require('../SourceDeviceHelper');
const { setTimeoutPromise } = require('../Util');

class BatDriver extends Driver {

  async onInit() {
    this.log('onInit');
    await super.onInit().catch(this.error);

    // Add listener for hourly trigger
    this.registerHourlyListener();

    // Add listener for retry logic
    this.registerRetryListener();

    // Add listener for new prices
    this.registerTariffListener();

    // Start polling Homey Cumulative Energy
    await this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log('bat driver onUninit called');
    if (this.intervalIdEnergyPoll) {
      this.homey.clearInterval(this.intervalIdEnergyPoll);
      this.homey.clearTimeout(this.intervalIdEnergyPoll);
    }

    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);
    if (this.eventListenerTariff) this.homey.removeListener('set_tariff_power_PBTH', this.eventListenerTariff);

    await setTimeoutPromise(3000, this);
  }

  registerHourlyListener() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);

    this.eventListenerHour = () => {
      (async () => {
        try {
          await setTimeoutPromise(Math.random() * 20000, this);
          const devices = await this.getDevices();
          for (const device of devices) {
            await this.checkAndPollDevice(device);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on('everyhour_PBTH', this.eventListenerHour);
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
    await device.poll();
    await device.setAvailable().catch((err) => this.error(err));
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
          if (!args.pricesNextHours || !args.pricesNextHours[0]) {
            this.log('no prices next hours found');
            return;
          }

          this.pricesNextHours = this.pricesNextHours || {};
          this.pricesNextHoursMarketLength = this.pricesNextHoursMarketLength || {};
          this.pricesNextHoursIsForecast = this.pricesNextHoursIsForecast || {};
          this.priceIntervals = this.priceIntervals || {};

          this.pricesNextHours[args.group] = args.pricesNextHours;
          this.pricesNextHoursIsForecast[args.group] = args.pricesNextHoursIsForecast;
          this.pricesNextHoursMarketLength[args.group] = args.pricesNextHoursMarketLength;
          this.priceIntervals[args.group] = args.priceInterval;

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
    const pricesNextHoursMarketLength = this.pricesNextHoursMarketLength[updateGroup];
    const pricesNextHoursIsForecast = this.pricesNextHoursIsForecast[updateGroup];

    this.log('updating prices', deviceName, pricesNextHours[0], pricesNextHoursMarketLength);
    await device.updatePrices([...pricesNextHours], pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast);
  }

  // Poll Cumulative Energy for NOM/XOM
  async startPollingEnergy(interval) {
    const int = interval || 5; // 1 second for realtime-ish updates
    if (this.intervalIdEnergyPoll) {
      this.homey.clearInterval(this.intervalIdEnergyPoll);
      this.homey.clearTimeout(this.intervalIdEnergyPoll);
    }

    // wait for api to be ready
    let retries = 0;
    let api;
    while (!api && retries < 60) {
      try {
        api = this.homey.app.api;
      } catch (e) {
        // ignore
      }
      if (api) break;
      await setTimeoutPromise(1000, this);
      retries += 1;
      if (this.isDestroyed) return;
    }
    if (!api) {
      this.log('Homey API not ready, cannot start energy polling');
      return;
    }

    this.log(`start polling Cumulative XOM Energy @${int} seconds interval`);

    let lastCumulativePower = null;
    let lastProcessTime = 0;

    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        const report = await api.energy.getLiveReport().catch((err) => this.error(err));
        // console.log(`totalConsumed: ${report.totalConsumed.W}, totalCumulative: ${report.totalCumulative.W}, totalGenerated: ${report.totalGenerated.W}`);
        // console.log('cumulative:', report?.items.filter((i) => i.type === 'cumulative'));
        // console.log('generator:', report?.items.filter((i) => i.type === 'generator'));
        // console.log('isEVCharger:', report?.items.filter((i) => i.isEVCharger));
        // console.log('isHomeBattery:', report?.items.filter((i) => i.isHomeBattery));
        // console.log(await this.homey.app.api.energy.getState().catch((err) => this.error(err)));

        const cumulativePower = report?.totalCumulative?.W;
        if (Number.isFinite(cumulativePower) && Math.abs(cumulativePower) <= 30000) {
          const now = Date.now();
          if (cumulativePower !== lastCumulativePower || (now - lastProcessTime) > 10000) {
            const timeDelta = lastProcessTime > 0 ? (now - lastProcessTime) / 1000 : int;
            lastCumulativePower = cumulativePower;
            lastProcessTime = now;
            await this.processEnergyLogic(cumulativePower, timeDelta);
          }
        }
      } catch (error) {
        this.error(error);
      } finally {
        if (!this.isDestroyed) {
          this.intervalIdEnergyPoll = this.homey.setTimeout(poll, 1000 * int);
        }
      }
    };
    poll();
  }

  async processEnergyLogic(cumulativePower, interval) {
    // Get the flow settings
    let app;
    try {
      app = this.homey.app;
    } catch (e) {
      return;
    }
    const xomSettings = app.xomSettings || this.homey.settings.get('xomSettings') || {};
    const { smoothing = 50, x = 0, minLoad = 50 } = xomSettings;
    const samples = Math.max(1, Math.round((smoothing / 100) * (120 / Math.max(1, interval))));

    const devices = await this.getDevices();
    const strategy = nomXomStrategy.getStrategy({
      devices,
      cumulativePower,
      x,
      minLoad,
    });

    // Trigger NOM strategy flow for all battery devices
    devices.forEach((device) => {
      const strat = strategy.find((info) => info.id === device.getData().id);
      device.triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
    });
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
      const HP2023 = this.homey.platformVersion === 2;

      // add advanced ROI capabilities
      if (HP2023) allCaps.push('roi_duration');

      keys.forEach((key) => {
        const homeyDevice = allDevices[key];
        const hasCapability = (capability) => homeyDevice.capabilities.includes(capability);

        let found = false;

        // 1. Check for compatible sourceCapGroup in app sources (Old Way / Priority)
        // Check for required capabilities
        found = this.ds.originDeviceCapabilities.some(hasCapability);

        if (found) {
          found = this.ds.sourceCapGroups.some((capGroup) => {
            const requiredKeys = Object.values(capGroup).filter((v) => v);
            return requiredKeys.every((k) => homeyDevice.capabilities.includes(k));
          });
        }

        // 2. Check for energy object (New Standard / Fallback)
        if (!found && homeyDevice.energy && homeyDevice.energy.homeBattery) {
          let soc = null;
          let productionPower = null;

          // Find SoC capability
          if (hasCapability('measure_battery')) soc = 'measure_battery';

          // Find Power capability
          if (hasCapability('measure_power')) productionPower = 'measure_power';
          else if (hasCapability('measure_power.battery')) productionPower = 'measure_power.battery';

          if (soc && productionPower) {
            found = true;
            // Add to sourceCapGroups if this combination doesn't exist yet
            // This ensures BatDevice can find the correct mapping later
            const exists = this.ds.sourceCapGroups.some((g) => g.soc === soc && g.productionPower === productionPower);
            if (!exists) {
              this.ds.sourceCapGroups.push({ soc, productionPower });
            }
          }
        }

        if (found) {
          const device = {
            name: `${homeyDevice.name}_Σ`,
            data: {
              id: `PH_${this.ds.driverId}_${homeyDevice.id}_${randomId}`,
            },
            settings: {
              homey_device_id: homeyDevice.id,
              homey_device_name: homeyDevice.name,
              level: this.homey.app.manifest.version,
              tariff_update_group: 1,
              roiEnable: HP2023, // Enabled by default on HP2023
            },
            capabilities: allCaps,
          };
          devices.push(device);
        }
      });

      return devices;
    } catch (error) {
      return Promise.reject(error);
    }
  }

}

module.exports = BatDriver;
