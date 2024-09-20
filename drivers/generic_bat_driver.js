/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const { Driver } = require('homey');
const crypto = require('crypto');
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

// const battApps = [
//  'nl.sessy',
// ];

class BatDriver extends Driver {

  async onDriverInit() {
    this.log('onDriverInit');
    // add listener for hourly trigger
    if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
    this.eventListenerHour = async () => {
      // console.log('new hour event received');
      const devices = await this.getDevices();
      devices.forEach(async (device) => {
        try {
          const deviceName = device.getName();
          // HOMEY-API device
          // check if source device exists
          const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj && (device.sourceDevice.available !== null);
          if (!sourceDeviceExists) {
            this.error(`Source device ${deviceName} is missing.`);
            await device.setUnavailable('Source device is missing. Retry in 10 minutes.').catch(this.error);
            device.restartDevice(10 * 60 * 1000).catch(this.error); // restart after 10 minutes
            return;
          }
          // poll all capabilities
          await device.poll();
          await device.setAvailable().catch(this.error);
        } catch (error) {
          this.error(error);
        }
      });
    };
    this.homey.on('everyhour', this.eventListenerHour);

    // add listener for 5 minute retry
    if (this.eventListenerRetry) this.homey.removeListener('retry', this.eventListenerRetry);
    this.eventListenerRetry = async () => {
      const devices = await this.getDevices();
      devices.forEach(async (device) => {
        try {
          const deviceName = device.getName();
          if (device.migrating || device.restarting) return;
          if (!device.initReady) {
            this.log(`${deviceName} Restarting now`);
            // device.onInit();
            device.restartDevice(500).catch(this.error);
          }
          // HOMEY-API device - check if source device exists
          const sourceDeviceExists = device.sourceDevice && device.sourceDevice.capabilitiesObj
            && Object.keys(device.sourceDevice.capabilitiesObj).length > 0 && (device.sourceDevice.available !== null);
          if (!sourceDeviceExists) {
            // console.log(deviceName, device.sourceDevice && device.sourceDevice.capabilitiesObj, device.sourceDevice && device.sourceDevice.available);
            this.error(`Source device ${deviceName} is missing. Restarting now.`);
            await device.setUnavailable('Source device is missing. Retrying ..').catch(this.error);
            device.restartDevice(500).catch(this.error);
          }
        } catch (error) {
          this.error(error);
        }
      });
    };
    this.homey.on('retry', this.eventListenerRetry);

    // set prices for a BAT device
    this.setPricesDevice = (device) => {
      const deviceName = device.getName();
      const updateGroup = device.getSettings().tariff_update_group;
      if (!updateGroup || !this.pricesNextHours || !this.pricesNextHours[updateGroup]) {
        this.log('No prices available for group', updateGroup, deviceName);
        return;
      }
      const pricesNextHours = this.pricesNextHours[updateGroup];
      const pricesNextHoursMarketLength = this.pricesNextHoursMarketLength[updateGroup];
      this.log('updating prices', deviceName, pricesNextHours[0], pricesNextHoursMarketLength);
      device.updatePrices([...pricesNextHours], pricesNextHoursMarketLength);
    };

    // add listener for new prices
    const eventName = 'set_tariff_power';
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
    this.eventListenerTariff = async (args) => {
      // console.log(`${eventName} received from DAP`, args);
      // eslint-disable-next-line prefer-destructuring
      if (!args.pricesNextHours || !args.pricesNextHours[0]) {
        this.log('no prices next hours found');
        return;
      }
      if (!this.pricesNextHours) this.pricesNextHours = {};
      if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = {};
      this.pricesNextHours[args.group] = args.pricesNextHours;
      this.pricesNextHoursMarketLength[args.group] = args.pricesNextHoursMarketLength;
      // wait 2 seconds not to stress Homey and prevent race issues
      await setTimeoutPromise(2 * 1000);
      const devices = await this.getDevices();
      devices.forEach((device) => this.setPricesDevice(device));
    };
    this.homey.on(eventName, this.eventListenerTariff);

    // start polling Homey Cumulative Energy
    // this.avgCumPower = 0;
    await this.startPollingEnergy().catch(this.error);
  }

  async onUninit() {
    this.log('bat driver onUninit called');
    if (this.intervalIdEnergyPoll) this.homey.clearInterval(this.intervalIdEnergyPoll);
    if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
    if (this.eventListenerRetry) this.homey.removeListener('retry', this.eventListenerRetry);
    const eventName = 'set_tariff_power';
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
    await setTimeoutPromise(3000);
  }

  // Poll Cumulative Energy for NOM/XOM
  async startPollingEnergy(interval) {
    const int = interval || 10; // seconden
    this.homey.clearInterval(this.intervalIdEnergyPoll);
    await setTimeoutPromise(20000);
    this.log(`start polling Cumulative XOM Energy @${int} seconds interval`);
    this.intervalIdEnergyPoll = this.homey.setInterval(async () => {
      try {
        // get the flow settings
        const xomSettings = await this.homey.settings.get('xomSettings') || {};
        const { smoothing = 50, x = 0, minLoad = 50 } = xomSettings;
        const samples = Math.round((smoothing / 100) * (120 / int)); // 2 minutes smoothing = 100%. Default is 50% = 1 minutes
        const maxSocDelta = 0; // 10 when delta soc is higher, load will swith to other batt

        // get cumulative power from Homey Power
        const report = await this.homey.app.api.energy.getLiveReport().catch(this.error);
        const cumulativePower = (report && report.totalCumulative && report.totalCumulative.W);
        if (!Number.isFinite(cumulativePower)) return;

        // strategy: divide required power based on SoC ratio. Assume all batteries are used!
        const devices = await this.getDevices();
        const batterieInfo = devices
          .map((device) => {
            const info = {
              id: device.getData().id,
              name: device.getName(),
              maxCharge: device.getSettings().chargePower,
              maxDischarge: device.getSettings().dischargePower,
              soc: device.soc,
              actualPower: device.getCapabilityValue('measure_watt_avg'),
              xomTargetPower: device.xomTargetPower,
            };
            return info;
          })
          .filter((info) => Number.isFinite(info.actualPower))
          .filter((info) => Number.isFinite(info.soc));

        const totalBattSoc = batterieInfo.reduce((sum, currentValue) => sum + currentValue.soc, 0);
        const totalBattpower = batterieInfo.reduce((sum, currentValue) => sum + currentValue.actualPower, 0);
        const totalTarget = cumulativePower + totalBattpower - x; // x and smoothing are settable by app flow
        let strategy = []; // array of strategies per battery

        // calculate strategy and headroom per battery
        strategy = batterieInfo.map((info) => {
          let fraction = 0;
          let target = 0;
          if (totalTarget > 0) {
            fraction = (totalBattSoc > 0) ? (info.soc / totalBattSoc) : 0;
          } // discharge needed
          if (totalTarget < 0) {
            fraction = (totalBattSoc > 0) ? ((totalBattSoc - info.soc) / totalBattSoc) : 0;
          } // charge needed
          target = totalTarget * fraction;
          // set minimum and maxumum targets
          if (target > info.maxDischarge) target = info.maxDischarge;
          if (target < -info.maxCharge) target = -info.maxCharge;
          if ((target < minLoad) && (target > -minLoad)) target = 0;
          // calculate power headroom
          let headroom = 0;
          if (totalTarget > 0) headroom = (info.soc > 0) ? (info.maxDischarge - target) : 0;
          if (totalTarget < 0) headroom = (info.soc < 100) ? (target - info.maxCharge) : 0;
          const strat = { ...info };
          strat.target = target;
          strat.headroom = headroom;
          return strat;
        });
        // console.log('strat before redist:', strategy);

        // distribute remaining power
        const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
        const totalDelta = (totalTarget - totalStratTarget);
        // console.log('unresolved rest power:', totalDelta);
        if (Math.abs(totalDelta) > 10) {
          let restDelta = totalDelta;
          // distribute remaining power over active batteries that have not reached limit
          const activeBatsWithHeadroom = strategy.filter((info) => info.target && info.headroom);
          const totalHeadroom = activeBatsWithHeadroom.reduce((sum, currentValue) => sum + currentValue.headroom, 0);
          // strategy = strategy.sort((a, b) => Math.abs(b.headroom) - Math.abs(a.headroom)); // use highest headroom first
          if (activeBatsWithHeadroom.length) { // there is at least one active batt with headroom
            strategy = strategy.map((info) => {
              if (!info.headroom || !info.target || (Math.abs(restDelta) < 10)) return info;
              let delta = restDelta * (info.headroom / totalHeadroom); // map part of restDelta
              if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom; // discharging more than max
              if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom; // charging more than max
              restDelta -= delta;
              const strat = { ...info };
              strat.target = info.target + delta;
              strat.headroom = info.headroom - delta;
              return strat;
            });
          }
          // map all remaining power to first running batt with headroom and significant (maxSocDelta 10%?) better soc
          if (Math.abs(totalDelta) > 10) {
            // use best SOC first, but only if significant (10%?) better soc then running batt
            if (restDelta > 0) { // discharging
              // strategy.sort((a, b) => b.actualPower - a.actualPower); // highest running load first
              strategy.sort((a, b) => b.soc - a.soc + maxSocDelta); // higher soc first.
            }
            if (restDelta < 0) { // charging
              // strategy.sort((a, b) => a.actualPower - b.actualPower); // highest negative running load first
              strategy.sort((a, b) => a.soc - b.soc - maxSocDelta); // lower soc first.
            }
            strategy = strategy.map((info) => {
              if (!info.headroom || (Math.abs(restDelta) < 10)) return info;
              let delta = restDelta; // all remaining power to first hit
              if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom; // discharging more than max
              if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom; // charging ore than max
              restDelta -= delta;
              const strat = { ...info };
              strat.target = info.target + delta;
              strat.headroom = info.headroom - delta;
              return strat;
            });
          }
          // console.log('strat after rest distribution:', restDelta, strategy);
        }

        // trigger NOM strategy flow for all battery devices
        devices.forEach((device) => {
          const strat = strategy.find((info) => info.id === device.getData().id);
          let targetPower = 0;
          if (strat) targetPower = strat.target;
          // eslint-disable-next-line no-param-reassign
          if (!device.xomTargetPower) {
            device.xomTargetPower = targetPower;
          }
          // eslint-disable-next-line no-param-reassign
          device.xomTargetPower = (targetPower / samples) + (device.xomTargetPower * ((samples - 1) / samples)); // smoothing 2 minutes
          const tokens = {
            power: Math.round(device.xomTargetPower),
            x,
            smoothing,
            minLoad,
          };
          // console.log(`${device.getName()} P1act: ${cumulativePower} battAct:${strat.actualPower} BattNew:${tokens.power}`);
          const state = {}; // args;
          this.homey.app.triggerXOMStrategy(device, tokens, state);
        });
      } catch (error) {
        this.error(error);
      }
    }, 1000 * int);
  }

  // stuff to find Homey battery devices
  async onPairListDevices() {
    try {
      this.log('listing of devices started');
      const randomId = crypto.randomBytes(3).toString('hex');
      this.devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch(this.error);
      const keys = Object.keys(allDevices);
      const allCaps = this.ds.deviceCapabilities;
      // check if on HP2023 > add advanced ROI capabilities
      const HP2023 = this.homey.platformVersion === 2;
      if (HP2023) {
        allCaps.push('roi_duration');
      }
      keys.forEach((key) => {
        const hasCapability = (capability) => allDevices[key].capabilities.includes(capability);
        let found = this.ds.originDeviceCapabilities.some(hasCapability);
        // check for compatible sourceCapGroup in app sources
        let hasSourceCapGroup = false;
        if (found) {
          this.ds.sourceCapGroups.forEach((capGroup) => {
            if (hasSourceCapGroup) return; // stop at the first match
            const requiredKeys = Object.values(capGroup).filter((v) => v);
            const hasAllKeys = requiredKeys.every((k) => allDevices[key].capabilities.includes(k));
            if (hasAllKeys) hasSourceCapGroup = true; // all relevant capabilities were found in the source device
          });
          found = hasSourceCapGroup;
        }
        if (found) {
          const device = {
            name: `${allDevices[key].name}_Σ`,
            data: {
              id: `PH_${this.ds.driverId}_${allDevices[key].id}_${randomId}`,
            },
            settings: {
              homey_device_id: allDevices[key].id,
              homey_device_name: allDevices[key].name,
              level: this.homey.app.manifest.version,
              tariff_update_group: 1,
              roiEnable: false,
            },
            capabilities: allCaps,
          };
          if (HP2023) {
            device.settings.roiEnable = true;
          }
          this.devices.push(device);
        }
      });
      return Promise.all(this.devices);
    } catch (error) {
      return Promise.reject(error);
    }
  }

}

module.exports = BatDriver;
