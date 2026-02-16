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

const dailyResetApps = [
  'com.tibber',
  'it.diederik.solar',
  'com.toshiba',
];

class SumMeterDriver extends Driver {

  async onInit() {
    this.log('onInit');
    await super.onInit().catch(this.error);

    // add listener for hourly trigger
    this.registerHourlyListener();

    // add listener for tariff change
    this.registerTariffListener();

    // add listener for 5 minute retry
    this.registerRetryListener();
  }

  async onUninit() {
    this.log('sum driver onUninit called');
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);
    const eventName = `set_tariff_${this.id}_PBTH`;
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
    await setTimeoutPromise(3000, this);
  }

  registerHourlyListener() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);

    this.eventListenerHour = () => {
      (async () => {
        try {
          const devices = this.getDevices();
          for (const device of devices) {
            await this.handleHourlyUpdate(device);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((error) => {
        this.error('Unhandled error in eventListenerHour:', error);
      });
    };
    this.homey.on('everyhour_PBTH', this.eventListenerHour);
  }

  async handleHourlyUpdate(device) {
    const deviceName = device.getName();

    // HOMEY_ENERGY device
    if (device.getSettings().source_device_type.includes('Homey Energy')) {
      await device.pollMeter();
      return;
    }

    // METER_VIA_FLOW device
    if (device.getSettings().source_device_type === 'virtual via flow') {
      await device.updateMeterFromFlow(null);
      return;
    }

    // HOMEY-API device check
    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch (error) {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch(this.error);
      return; // Added return to stop execution for this device
    }

    // METER_VIA_WATT device
    if (device.driver.id === 'power' && device.getSettings().use_measure_source) {
      await device.updateMeterFromMeasure(null);
      return;
    }

    // check if listener or polling is on, otherwise restart device
    const ignorePollSetting = (device.getSettings().source_device_type !== 'virtual via flow')
      && !device.getSettings().use_measure_source;
    const pollingIsOn = !!device.getSettings().interval && device.intervalIdDevicePoll
      && (device.intervalIdDevicePoll._idleTimeout > 0);
    const listeningIsOn = Object.keys(device.capabilityInstances).length > 0;

    if (ignorePollSetting && !pollingIsOn && !listeningIsOn) {
      this.error(`${deviceName} is not in polling or listening mode. Restarting now..`);
      device.restartDevice(1000).catch((err) => this.error(err));
      return;
    }

    // check if source device is available
    if (!device.sourceDevice.available) {
      this.error(`Source device ${deviceName} is unavailable.`);
      device.log('trying hourly poll', deviceName);
      await device.pollMeter();
      return;
    }

    // force poll, unless wait for listener is setup
    let doPoll = true;
    if (device.getSettings().wait_for_update) {
      const waitTime = device.getSettings().wait_for_update * 60 * 1000;
      await setTimeoutPromise(waitTime, device);
      // check if new hour was already registered
      const now = new Date();
      const lastReadingTm = new Date(device.lastReadingHour.meterTm);
      if (now.getHours() === lastReadingTm.getHours()) doPoll = false;
    }

    if (doPoll) {
      device.log('doing hourly poll', deviceName);
      await device.pollMeter();
    }
    await device.setAvailable().catch((err) => this.error(err));
  }

  registerTariffListener() {
    const eventName = `set_tariff_${this.id}_PBTH`;
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);

    this.eventListenerTariff = (args) => {
      (async () => {
        try {
          this.log(`${eventName} received from flow or DAP`, args);
          const currentTm = new Date();
          const tariff = args.tariff === null ? null : Number(args.tariff);
          const group = args.group || 1;

          if (!Number.isFinite(tariff)) {
            this.error('the tariff is not a valid number');
            return;
          }

          this.tariffs = this.tariffs || {};
          this.tariffs[group] = tariff;

          await setTimeoutPromise(2 * 1000, this);

          const devices = this.getDevices();
          for (const device of devices) {
            if (device.settings && device.settings.tariff_update_group && device.settings.tariff_update_group === group) {
              const deviceName = device.getName();
              this.log('updating tariff', deviceName, tariff);
              device.updateTariffHistory(tariff, currentTm);
            }
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((error) => {
        this.error('Unhandled error in eventListenerTariff:', error);
      });
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  updateDeviceTariff(device, overrideGroup) {
    const deviceName = device.getName();
    const updateGroup = overrideGroup || device.getSettings().tariff_update_group;

    if (!updateGroup || !this.tariffs || this.tariffs[updateGroup] === undefined) {
      this.log('No tariff available for group', updateGroup, deviceName);
      return;
    }

    const tariff = this.tariffs[updateGroup];
    this.log('updating tariff', deviceName, tariff);
    device.updateTariffHistory(tariff, new Date());
  }

  registerRetryListener() {
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);

    this.eventListenerRetry = () => {
      (async () => {
        try {
          const devices = this.getDevices();
          for (const device of devices) {
            await this.checkDeviceHealth(device);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((error) => {
        this.error('Unhandled error in eventListenerRetry:', error);
      });
    };
    this.homey.on('retry_PBTH', this.eventListenerRetry);
  }

  async checkDeviceHealth(device) {
    const deviceName = device.getName();
    if (device.migrating || device.restarting) return;

    if (!device.initReady) {
      this.log(`${deviceName} Restarting now`);
      device.restartDevice(5000 + Math.random() * 20000).catch((err) => this.error(err));
    }

    const settings = device.getSettings();
    if (settings.source_device_type !== 'Homey device') return;

    // HOMEY-API device - check if source device exists
    try {
      device.sourceDevice = await SourceDeviceHelper.getSourceDevice(device);
    } catch (error) {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch((err) => this.error(err));
    }
  }

  async onPair(session) {
    this.log('Pairing of new device started');
    session.setHandler('list_devices', () => this.discoverDevices());
  }

  async onRepair(session, device) {
    this.log('Repairing of device started', device.getName());
    let selectedDevices = [];
    session.setHandler('list_devices', () => this.discoverDevices());
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
          source_device_type: dev.settings.source_device_type,
          homey_energy: dev.settings.homey_energy,
          use_measure_source: dev.settings.use_measure_source,
          homey_device_daily_reset: dev.settings.homey_device_daily_reset,
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

  // stuff to find Homey devices
  async discoverDevices() {
    try {
      if (!this.homey.app.api) throw new Error(this.homey.__('error_homey_api_not_ready'));
      const randomId = crypto.randomBytes(3).toString('hex');
      const devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
      if (!allDevices) return [];
      const keys = Object.keys(allDevices);
      const allCaps = this.ds.deviceCapabilities;
      const reducedCaps = allCaps.filter((cap) => !cap.includes('meter_target'));
      for (const key of keys) {
        if (this.ds.requiredClass) {
          const deviceClass = allDevices[key].class;
          const { virtualClass } = allDevices[key];
          if (deviceClass !== this.ds.requiredClass && virtualClass !== this.ds.requiredClass) continue;
        }

        const hasCapability = (capability) => allDevices[key].capabilities.includes(capability);
        let found = this.ds.originDeviceCapabilities.some(hasCapability);

        // check for compatible sourceCapGroup in power sources
        let hasSourceCapGroup = false;
        let useMeasureSource = false;
        if (found && this.ds.driverId === 'power') {
          for (const capGroup of this.ds.sourceCapGroups) {
            if (hasSourceCapGroup) continue; // stop at the first match
            const requiredKeys = Object.values(capGroup).filter((v) => v);
            const hasAllKeys = requiredKeys.every((k) => allDevices[key].capabilities.includes(k));
            if (hasAllKeys) hasSourceCapGroup = true; // all relevant capabilities were found in the source device
          }
          if (!hasSourceCapGroup && !allDevices[key].capabilities.includes('measure_power')) {
            this.log('incompatible source caps', allDevices[key].driverId, allDevices[key].capabilities);
            found = false;
          }
          useMeasureSource = !hasSourceCapGroup;
        }
        if (found) {
          const device = {
            name: `${allDevices[key].name}_Σ${this.ds.driverId}`,
            data: {
              id: `PH_${this.ds.driverId}_${allDevices[key].id}_${randomId}`,
            },
            settings: {
              homey_device_id: allDevices[key].id,
              homey_device_name: allDevices[key].name,
              level: this.homey.app.manifest.version,
              source_device_type: 'Homey device',
              use_measure_source: useMeasureSource,
              tariff_update_group: 1,
              distribution: 'NONE',
            },
            capabilities: allCaps,
          };
          if (dailyResetApps.some((appId) => allDevices[key].driverId.includes(appId))) {
            device.settings.homey_device_daily_reset = true;
          }
          if (allDevices[key].energyObj && allDevices[key].energyObj.cumulative) device.settings.distribution = 'el_nl_2023';
          if (this.ds.driverId === 'gas') device.settings.distribution = 'gas_nl_2023';
          if (this.ds.driverId === 'water') device.settings.distribution = 'linear';
          if (!(allDevices[key].driverId.includes('com.gruijter.powerhour') // ignore own app devices
            || allDevices[key].driverId === 'homey')) devices.push(device); // ignore homey virtual power device
          if (device.settings.distribution === 'NONE') device.capabilities = reducedCaps;
        }
      }
      // show cumulative devices first ('NONE' is smaller than 'el_nl_2023')
      devices.sort((a, b) => b.settings.distribution.localeCompare(a.settings.distribution));

      // add Homey Energy virtual devices
      if (this.ds.driverId === 'power') {
        devices.push(
          {
            name: `HOMEY_ENERGY_SMARTMETERS_Σ${this.ds.driverId}`,
            data: {
              id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
            },
            settings: {
              homey_device_id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
              homey_device_name: `HOMEY_ENERGY_CUMULATIVE_${randomId}`,
              level: this.homey.app.manifest.version,
              homey_energy: 'totalCumulative',
              interval: 1,
              source_device_type: 'Homey Energy Smart Meters',
              tariff_update_group: 1,
              distribution: 'linear',
            },
            capabilities: allCaps,
          },
          {
            name: `HOMEY_ENERGY_SOLARPANELS_Σ${this.ds.driverId}`,
            data: {
              id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
            },
            settings: {
              homey_device_id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
              homey_device_name: `HOMEY_ENERGY_GENERATED_${randomId}`,
              level: this.homey.app.manifest.version,
              homey_energy: 'totalGenerated',
              interval: 1,
              source_device_type: 'Homey Energy Solar Panels',
              tariff_update_group: 1,
              distribution: 'NONE',
            },
            capabilities: reducedCaps,
          },
          {
            name: `HOMEY_ENERGY_DEVICES_Σ${this.ds.driverId}`,
            data: {
              id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
            },
            settings: {
              homey_device_id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
              homey_device_name: `HOMEY_ENERGY_DEVICES_${randomId}`,
              level: this.homey.app.manifest.version,
              homey_energy: 'totalConsumed',
              interval: 1,
              source_device_type: 'Homey Energy Devices',
              tariff_update_group: 1,
              distribution: 'NONE',
            },
            capabilities: reducedCaps,
          },
        );
      }

      // add virtual device
      devices.push(
        {
          name: `VIRTUAL_VIA_FLOW_Σ${this.ds.driverId}`,
          data: {
            id: `PH_${this.ds.driverId}_${randomId}`,
          },
          settings: {
            homey_device_id: `PH_${this.ds.driverId}_${randomId}`,
            homey_device_name: `VIRTUAL_METER_${randomId}`,
            level: this.homey.app.manifest.version,
            source_device_type: 'virtual via flow',
            // meter_via_flow: true,
            tariff_update_group: 1,
            distribution: 'NONE',
          },
          capabilities: reducedCaps,
        },
      );

      return devices;
    } catch (error) {
      return Promise.reject(error);
    }
  }

}

module.exports = SumMeterDriver;
