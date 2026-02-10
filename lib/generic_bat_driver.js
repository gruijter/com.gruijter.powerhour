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
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

class BatDriver extends Driver {

  async onDriverInit() {
    this.log('onDriverInit');

    // Add listener for hourly trigger
    this.registerHourlyListener();

    // Add listener for retry logic
    this.registerRetryListener();

    // Add listener for new prices
    this.registerTariffListener();

    // Start polling Homey Cumulative Energy
    await this.startPollingEnergy().catch((err) => this.error(err));
  }

  async onUninit() {
    this.log('bat driver onUninit called');
    if (this.intervalIdEnergyPoll) {
      this.homey.clearInterval(this.intervalIdEnergyPoll);
      this.homey.clearTimeout(this.intervalIdEnergyPoll);
    }

    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);
    if (this.eventListenerTariff) this.homey.removeListener('set_tariff_power_PBTH', this.eventListenerTariff);

    await setTimeoutPromise(3000);
  }

  registerHourlyListener() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);

    this.eventListenerHour = () => {
      (async () => {
        try {
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
    const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj && (device.sourceDevice.available !== null);

    if (!sourceDeviceExists) {
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
    const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj
      && Object.keys(device.sourceDevice.capabilitiesObj).length > 0 && (device.sourceDevice.available !== null);

    if (!sourceDeviceExists) {
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
          await setTimeoutPromise(2 * 1000);

          const devices = await this.getDevices();
          devices.forEach((device) => this.setPricesDevice(device));
        } catch (error) {
          this.error(error);
        }
      })().catch((err) => this.error(err));
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  setPricesDevice(device, overrideGroup) {
    const deviceName = device.getName();
    const updateGroup = overrideGroup || device.getSettings().tariff_update_group;

    if (!updateGroup || !this.pricesNextHours || !this.pricesNextHours[updateGroup]) {
      this.log('No prices available for group', updateGroup, deviceName);
      return;
    }

    const priceInterval = this.priceIntervals[updateGroup] || 60;
    const pricesNextHours = this.pricesNextHours[updateGroup];
    const pricesNextHoursMarketLength = this.pricesNextHoursMarketLength[updateGroup];
    const pricesNextHoursIsForecast = this.pricesNextHoursIsForecast[updateGroup];

    this.log('updating prices', deviceName, pricesNextHours[0], pricesNextHoursMarketLength);
    device.updatePrices([...pricesNextHours], pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast);
  }

  // Poll Cumulative Energy for NOM/XOM
  async startPollingEnergy(interval) {
    const int = interval || 10; // seconds
    if (this.intervalIdEnergyPoll) {
      this.homey.clearInterval(this.intervalIdEnergyPoll);
      this.homey.clearTimeout(this.intervalIdEnergyPoll);
    }

    await setTimeoutPromise(20000);
    this.log(`start polling Cumulative XOM Energy @${int} seconds interval`);

    const poll = async () => {
      try {
        await this.pollEnergyLogic(int);
      } catch (error) {
        this.error(error);
      } finally {
        this.intervalIdEnergyPoll = this.homey.setTimeout(poll, 1000 * int);
      }
    };
    poll();
  }

  async pollEnergyLogic(interval) {
    if (!this.homey.app.api) return;
    // Get the flow settings
    const xomSettings = await this.homey.settings.get('xomSettings') || {};
    const { smoothing = 50, x = 0, minLoad = 50 } = xomSettings;
    const samples = Math.round((smoothing / 100) * (120 / interval));

    // Get cumulative power from Homey Power
    const report = await this.homey.app.api.energy.getLiveReport().catch((err) => this.error(err));
    const cumulativePower = (report && report.totalCumulative && report.totalCumulative.W);

    if (!Number.isFinite(cumulativePower)) return;
    if (Math.abs(cumulativePower) > 30000) throw new Error('Cumulative Power is not valid');

    // Strategy: divide required power based on SoC ratio. Assume all batteries are used!
    const devices = await this.getDevices();
    const batteryInfo = this.collectBatteryInfo(devices);

    const totalBattSoc = batteryInfo.reduce((sum, currentValue) => sum + currentValue.soc, 0);
    const totalBattpower = batteryInfo.reduce((sum, currentValue) => sum + currentValue.actualPower, 0);
    const totalTarget = cumulativePower + totalBattpower - x;

    let strategy = this.calculateStrategy(batteryInfo, totalTarget, totalBattSoc, minLoad);
    strategy = this.distributeRemainingPower(strategy, totalTarget);

    // Trigger NOM strategy flow for all battery devices
    this.triggerXOMFlows(devices, strategy, samples, x, smoothing, minLoad);
  }

  collectBatteryInfo(devices) {
    return devices
      .map((device) => ({
        id: device.getData().id,
        name: device.getName(),
        maxCharge: device.getSettings().chargePower,
        maxDischarge: device.getSettings().dischargePower,
        soc: device.soc,
        actualPower: device.getCapabilityValue('measure_watt_avg'),
        xomTargetPower: device.xomTargetPower,
      }))
      .filter((info) => Number.isFinite(info.actualPower))
      .filter((info) => Number.isFinite(info.soc));
  }

  calculateStrategy(batteryInfo, totalTarget, totalBattSoc, minLoad) {
    return batteryInfo.map((info) => {
      let fraction = 0;
      let target = 0;

      if (totalTarget > 0) {
        fraction = (totalBattSoc > 0) ? (info.soc / totalBattSoc) : 0;
      } else if (totalTarget < 0) {
        fraction = (totalBattSoc > 0) ? (1 - (info.soc / totalBattSoc)) : 0;
      }

      target = totalTarget * fraction;

      // Set minimum and maximum targets
      if (target > info.maxDischarge) target = info.maxDischarge;
      if (target < -info.maxCharge) target = -info.maxCharge;
      if ((target < minLoad) && (target > -minLoad)) target = 0;

      // Calculate power headroom
      let headroom = 0;
      if (totalTarget > 0) headroom = (info.soc > 0) ? (info.maxDischarge - target) : 0;
      if (totalTarget < 0) headroom = (info.soc < 100) ? -(info.maxCharge + target) : 0;

      return {
        ...info,
        target,
        headroom,
        fraction,
      };
    });
  }

  distributeRemainingPower(strategy, totalTarget) {
    const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
    const totalDelta = (totalTarget - totalStratTarget);

    if (Math.abs(totalDelta) <= 10) return strategy;

    let restDelta = totalDelta;
    const maxSocDelta = 0;

    // Distribute remaining power over active batteries that have not reached limit
    const activeBatsWithHeadroom = strategy.filter((info) => info.target && info.headroom);
    const totalHeadroom = activeBatsWithHeadroom.reduce((sum, currentValue) => sum + currentValue.headroom, 0);

    if (activeBatsWithHeadroom.length) {
      strategy = strategy.map((info) => {
        if (!info.headroom || !info.target || (Math.abs(restDelta) < 10)) return info;

        let delta = restDelta * (info.headroom / totalHeadroom);
        if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom;
        if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom;

        restDelta -= delta;
        return {
          ...info,
          target: info.target + delta,
          headroom: info.headroom - delta,
        };
      });
    }

    if (Math.abs(restDelta) > 10) {
      // Use best SOC first, but only if significant better soc then running batt
      if (restDelta > 0) { // discharging
        strategy.sort((a, b) => b.soc - a.soc + maxSocDelta);
      } else { // charging
        strategy.sort((a, b) => a.soc - b.soc - maxSocDelta);
      }

      strategy = strategy.map((info) => {
        if (!info.headroom || (Math.abs(restDelta) < 10)) return info;

        let delta = restDelta;
        if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom;
        if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom;

        restDelta -= delta;
        return {
          ...info,
          target: info.target + delta,
          headroom: info.headroom - delta,
        };
      });
    }

    return strategy;
  }

  triggerXOMFlows(devices, strategy, samples, x, smoothing, minLoad) {
    devices.forEach((device) => {
      const strat = strategy.find((info) => info.id === device.getData().id);
      const targetPower = strat ? strat.target : 0;

      if (!device.xomTargetPower) {
        device.xomTargetPower = targetPower;
      }

      // Smoothing
      device.xomTargetPower = (targetPower / samples) + (device.xomTargetPower * ((samples - 1) / samples));

      const tokens = {
        power: Math.round(device.xomTargetPower),
        x,
        smoothing,
        minLoad,
      };

      const state = {};
      if (this.homey.app.trigger_xom_strategy) this.homey.app.trigger_xom_strategy(device, tokens, state);
    });
  }

  // Stuff to find Homey battery devices
  async onPairListDevices() {
    try {
      if (!this.homey.app.api) throw new Error(this.homey.__('error_homey_api_not_ready'));
      this.log('listing of devices started');
      const randomId = crypto.randomBytes(3).toString('hex');
      const devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
      if (!allDevices) return [];

      const keys = Object.keys(allDevices);
      const allCaps = this.ds.deviceCapabilities;

      // Check if on HP2023 > add advanced ROI capabilities
      const HP2023 = this.homey.platformVersion === 2;
      if (HP2023) {
        allCaps.push('roi_duration');
      }

      keys.forEach((key) => {
        const homeyDevice = allDevices[key];
        const hasCapability = (capability) => homeyDevice.capabilities.includes(capability);

        // Check for required capabilities
        let found = this.ds.originDeviceCapabilities.some(hasCapability);

        // Check for compatible sourceCapGroup in app sources
        if (found) {
          found = this.ds.sourceCapGroups.some((capGroup) => {
            const requiredKeys = Object.values(capGroup).filter((v) => v);
            return requiredKeys.every((k) => homeyDevice.capabilities.includes(k));
          });
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

      return Promise.all(devices);
    } catch (error) {
      return Promise.reject(error);
    }
  }

}

module.exports = BatDriver;
