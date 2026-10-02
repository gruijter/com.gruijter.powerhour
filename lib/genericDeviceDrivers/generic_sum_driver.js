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
const MeterHelpers = require('../helpers/MeterHelpers');
const PairSetup = require('../helpers/PairSetup');
const SourceCaps = require('../helpers/SourceCaps');

const dailyResetApps = [
  'com.tibber',
  'it.diederik.solar',
  'com.toshiba',
];

class SumMeterDriver extends Driver {

  async onInit() {
    await super.onInit().catch(this.error);

    this.registerHourlyListener();
    this.register15mListener();
    this.registerTariffListener();

    // add listener for 5 minute retry
    this.registerRetryListener();
  }

  async onUninit() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);
    if (this.eventListenerRetry) this.homey.removeListener('retry_PBTH', this.eventListenerRetry);
    let eventType = this.id;
    if (eventType === 'solar' || eventType === 'grid') eventType = 'power';
    const eventName = `set_tariff_${eventType}_PBTH`;
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);
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
          const devices = this.getDevices();
          for (const device of devices) {
            await this.handleBoundaryUpdate(device, false);
            await setTimeoutPromise(500, this);
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

  register15mListener() {
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);

    this.eventListener15m = () => {
      (async () => {
        try {
          // See registerHourlyListener() above for why this jitter exists.
          await setTimeoutPromise(Math.random() * 8000, this);
          const devices = this.getDevices();
          for (const device of devices) {
            await this.handleBoundaryUpdate(device, true);
            await setTimeoutPromise(500, this);
          }
        } catch (error) {
          this.error(error);
        }
      })().catch((error) => this.error('Unhandled error in eventListener15m:', error));
    };
    this.homey.on('every15m_PBTH', this.eventListener15m);
  }

  async handleBoundaryUpdate(device, isQuarterly) {
    const deviceName = device.getName();

    const interval = device.priceInterval || 60;
    if (isQuarterly && interval === 60) return; // Skip quarterly updates for 60m devices

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
    } catch {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch((err) => this.error(err));
      return;
    }

    // METER_VIA_WATT device
    if ((device.driver.id === 'power' || device.driver.id === 'solar') && device.getSettings().use_measure_source) {
      await device.updateMeterFromMeasure(null);
      return;
    }

    // check if listener or polling is on, otherwise restart device
    const ignorePollSetting = (device.getSettings().source_device_type !== 'virtual via flow')
      && !device.getSettings().use_measure_source;
    const pollingIsOn = !!device.getSettings().interval && device.intervalIdDevicePoll;
    const listeningIsOn = Object.keys(device.capabilityInstances).length > 0;

    if (ignorePollSetting && !pollingIsOn && !listeningIsOn) {
      this.error(`${deviceName} is not in polling or listening mode. Restarting now..`);
      device.restartDevice(1000).catch((err) => this.error(err));
      return;
    }

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
      if (device.lastMoneyReadingTm) {
        const currentPeriod = MeterHelpers.startOfBlock(Date.now(), interval, device.timeZone);
        const lastPeriod = MeterHelpers.startOfBlock(device.lastMoneyReadingTm, interval, device.timeZone);
        if (currentPeriod === lastPeriod) doPoll = false;
      }
    }

    if (doPoll) {
      device.log('doing hourly poll', deviceName);
      await device.pollMeter();
    }
    await device.setAvailable().catch((err) => this.error(err));
  }

  // Extracted from the 'set_tariff_*_PBTH' event listener so it can also be awaited directly
  // by a flow action card (Flows.js) - the event-based path below is fire-and-forget (fine for
  // DAP's own automatic hourly broadcast, nothing waits on it), but a flow's "Set Tariff" action
  // card needs the real completion signal so a following card in the same flow doesn't race
  // against tariffs still being written to devices.
  // Serialised per DRIVER, not per group. The per-group scoping of the device loop below would
  // allow a finer key, but generic_bat_driver's equivalent loop touches every device regardless
  // of group, so both drivers use the same driver-wide scheme rather than two subtly different
  // ones. The cost is that groups broadcasting at the same boundary queue instead of overlapping
  // - a few seconds on an hourly/quarterly job, in exchange for a guarantee that every device in
  // a group sees the same broadcast order. See runExclusive() in helpers/Util.js.
  async applyTariffFromEvent(args) {
    return runExclusive(`tariff|${this.id}`, () => this.applyTariffFromEventExclusive(args));
  }

  async applyTariffFromEventExclusive(args) {
    let eventType = this.id;
    if (eventType === 'solar' || eventType === 'grid') eventType = 'power';
    const eventName = `set_tariff_${eventType}_PBTH`;

    const currentTm = new Date();

    let tariff = args.tariff === null ? null : Number(args.tariff);
    if (!Number.isFinite(tariff) && args.pricesNextHours && args.pricesNextHours.length > 0) {
      tariff = Number(args.pricesNextHours[0]);
    }
    let exportTariff = args.exportTariff !== undefined && args.exportTariff !== null ? Number(args.exportTariff) : undefined;
    if (!Number.isFinite(exportTariff) && args.exportPricesNextHours && args.exportPricesNextHours.length > 0) {
      exportTariff = Number(args.exportPricesNextHours[0]);
    }
    const group = args.group || 1;

    // Finest declared interval wins for the group, instead of last-write-wins. A flow's action
    // card declares no interval at all and therefore no longer votes for 60 by omission.
    // See lib/helpers/PriceIntervalGroups.js.
    const priceInterval = await PriceIntervalGroups.applyFor(this.homey, {
      channel: eventName,
      group,
      sourceId: args.sourceDeviceId,
      sourceName: args.sourceDeviceName,
      interval: args.priceInterval,
    });

    this.log(`${eventName} received from flow or DAP for group ${group}. Tariff: ${tariff}`);

    if (!Number.isFinite(tariff)) {
      this.error('the tariff is not a valid number');
      return;
    }

    this.tariffs = this.tariffs || {};
    this.exportTariffs = this.exportTariffs || {};
    this.priceIntervals = this.priceIntervals || {};
    this.currencies = this.currencies || {};
    this.pricesNextHours = this.pricesNextHours || {};
    this.exportPricesNextHours = this.exportPricesNextHours || {};
    this.pricesNextHoursMarketLength = this.pricesNextHoursMarketLength || {};
    this.pricesNextHours[group] = args.pricesNextHours;
    this.exportPricesNextHours[group] = args.exportPricesNextHours;
    this.pricesNextHoursMarketLength[group] = args.pricesNextHoursMarketLength;

    this.tariffs[group] = tariff;
    this.exportTariffs[group] = exportTariff;
    this.priceIntervals[group] = priceInterval;
    this.currencies[group] = args.currency;

    await setTimeoutPromise(2 * 1000, this);

    const devices = this.getDevices();
    let deviceIndex = 0;
    for (const device of devices) {
      if (device.settings && device.settings.tariff_update_group && device.settings.tariff_update_group === group) {
        if (deviceIndex > 0) {
          await setTimeoutPromise(50, this);
        }
        deviceIndex += 1;
        await device.updateTariffHistory(tariff, currentTm, priceInterval, exportTariff, args);
      }
    }
  }

  registerTariffListener() {
    let eventType = this.id;
    if (eventType === 'solar' || eventType === 'grid') eventType = 'power';
    const eventName = `set_tariff_${eventType}_PBTH`;
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);

    this.eventListenerTariff = (args) => {
      this.applyTariffFromEvent(args).catch((error) => {
        this.error('Unhandled error in eventListenerTariff:', error);
      });
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  // Shares applyTariffFromEvent()'s queue: this runs on pairing and on a tariff_update_group
  // change, and writes the same device state a broadcast loop writes, so it must not overlap one.
  updateDeviceTariff(device, overrideGroup) {
    return runExclusive(`tariff|${this.id}`, () => this.updateDeviceTariffExclusive(device, overrideGroup));
  }

  async updateDeviceTariffExclusive(device, overrideGroup) {
    const deviceName = device.getName();
    const updateGroup = overrideGroup || device.getSettings().tariff_update_group;

    if (!updateGroup || !this.tariffs || this.tariffs[updateGroup] === undefined) {
      this.log('No tariff available for group', updateGroup, deviceName);
      return;
    }

    const tariff = this.tariffs[updateGroup];
    const exportTariff = this.exportTariffs ? this.exportTariffs[updateGroup] : tariff;
    const priceInterval = this.priceIntervals ? this.priceIntervals[updateGroup] : 60;
    const args = {
      pricesNextHours: this.pricesNextHours ? this.pricesNextHours[updateGroup] : null,
      exportPricesNextHours: this.exportPricesNextHours ? this.exportPricesNextHours[updateGroup] : null,
      pricesNextHoursMarketLength: this.pricesNextHoursMarketLength ? this.pricesNextHoursMarketLength[updateGroup] : null,
      priceInterval,
      currency: this.currencies ? this.currencies[updateGroup] : null,
    };
    // Awaited on purpose: runExclusive() releases the `tariff|<driver>` lock when this method
    // resolves, so a fire-and-forget call would hand the lock back before the write it is meant to
    // serialise has happened - letting a queued applyTariffFromEventExclusive() write the same
    // device concurrently, which is the race this lock exists for. generic_bat_driver.js's
    // setPricesDeviceExclusive() is the matching pattern.
    await device.updateTariffHistory(tariff, new Date(), priceInterval, exportTariff, args);
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
    } catch {
      this.error(`Source device ${deviceName} is missing. Restarting now.`);
      await device.setUnavailable(this.homey.__('source_device_missing_retrying')).catch((err) => this.error(err));
      device.restartDevice(10000 + Math.random() * 60000).catch((err) => this.error(err));
    }
  }

  // With ds.setup the setup view follows the list (see lib/helpers/PairSetup.js).
  onPair(session) {
    this.log('Pairing of new device started');
    if (this.ds.setup) PairSetup.registerPair(this, session, () => this.discoverDevices());
    else session.setHandler('list_devices', () => this.discoverDevices());
  }

  async onRepair(session, device) {
    PairSetup.registerRepair(this, session, device, () => this.discoverDevices(), [
      'homey_device_id', 'homey_device_name', 'source_device_type', 'homey_energy',
      'use_measure_source', 'homey_device_daily_reset',
    ]);
  }

  // The capability list for these settings: paired with it, and kept on it by the device's migration.
  capabilitiesFor(settings = {}) {
    const caps = [...this.ds.deviceCapabilities];
    // Budget targets only with a budget.
    return settings.distribution === 'NONE' ? caps.filter((cap) => !cap.includes('meter_target')) : caps;
  }

  // The meter capabilities of a source device, as detected: { p1, p2, n1, n2 } or null.
  autoSourceCapGroup(sourceDevice) {
    const caps = sourceDevice.capabilities || [];
    const { fallbackMeter } = this.ds;
    // 1. Homey generic energy object (useful for solar panels and batteries)
    const energyData = sourceDevice.energyObj || sourceDevice.energy;
    const exportedCap = energyData && energyData.meterPowerExportedCapability;
    if (exportedCap && caps.includes(exportedCap)) {
      return {
        p1: exportedCap, p2: null, n1: null, n2: null,
      };
    }
    // 2. Driver specific capabilities
    const group = SourceCaps.matchGroup(caps, this.ds.sourceCapGroups);
    if (group) return { ...group };
    // 3. Single primary meter
    if (fallbackMeter && caps.includes(fallbackMeter)) {
      return {
        p1: fallbackMeter, p2: null, n1: null, n2: null,
      };
    }
    return null;
  }

  // The detected meter capabilities with the choice from the setup view, or null when none.
  sourceCapGroupFor(sourceDevice, stored) {
    const auto = this.autoSourceCapGroup(sourceDevice) || {
      p1: null, p2: null, n1: null, n2: null,
    };
    const roles = ((this.ds.setup && this.ds.setup.roles) || []).map((role) => role.key);
    const group = SourceCaps.applyChoice(sourceDevice, auto, roles, SourceCaps.chosenFor(stored, sourceDevice.id));
    return Object.values(group).some((v) => v) ? group : null;
  }

  // Homey Energy and flow devices have no source device settings.
  setupSettings(dev) {
    const ids = this.ds.setup.settings;
    if (dev.settings.source_device_type === 'Homey device') return ids;
    return ids.filter((id) => !['use_measure_source', 'homey_device_daily_reset'].includes(id));
  }

  async _setupSourceDevice(settings) {
    if (!(this.ds.setup && this.ds.setup.roles) || settings.source_device_type !== 'Homey device') return null;
    return PairSetup.apiDevice(this, settings.homey_device_id);
  }

  // Setup view: per meter role (ds.setup.roles) the capabilities of the source device.
  async setupRoles(dev, stored) {
    const source = await this._setupSourceDevice(dev.settings);
    if (!source) return null;
    const roles = this.ds.setup.roles.map((role) => ({ ...role, label: this.homey.__(`repair.setup_role_${role.label || role.key}`) }));
    const auto = this.autoSourceCapGroup(source) || {};
    return {
      deviceId: source.id,
      title: this.homey.__('repair.setup_caps_title'),
      text: `${source.name}. ${this.homey.__('repair.setup_caps_text')}`,
      items: SourceCaps.roleItems(source, roles, auto, SourceCaps.chosenFor(stored, source.id)),
    };
  }

  // Watt needs measure_power, else at least one meter capability.
  async setupValidate(settings, caps) {
    const source = await this._setupSourceDevice(settings);
    if (!source) return;
    if (settings.use_measure_source) {
      if (!(source.capabilities || []).includes('measure_power')) {
        throw Error(this.homey.__('error_setup_no_watt', { name: source.name }));
      }
      return;
    }
    if (!this.sourceCapGroupFor(source, { sourceId: source.id, caps })) {
      throw Error(this.homey.__('error_setup_caps_missing'));
    }
  }

  async discoverDevices() {
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch {
        // ignore
      }
      if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
      const randomId = crypto.randomBytes(3).toString('hex');
      const devices = [];

      const allDevices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
      if (!allDevices) return [];
      const keys = Object.keys(allDevices);
      const allCaps = this.ds.deviceCapabilities;
      const reducedCaps = allCaps.filter((cap) => !cap.includes('meter_target'));
      const listed = []; // { device, score }: see PairSetup.listScore()

      for (const key of keys) {
        const homeyDevice = allDevices[key];
        const compatibility = this.checkDeviceCompatibility(homeyDevice);

        if (compatibility.found) {
          const device = {
            name: PairSetup.listName(this, `${homeyDevice.name}_Σ${this.ds.driverId}`, compatibility),
            data: {
              id: `PH_${this.ds.driverId}_${homeyDevice.id}_${randomId}`,
            },
            settings: this.getDeviceSettings(homeyDevice),
          };

          if (compatibility.useMeasureSource) {
            device.settings.use_measure_source = true;
          }

          if (dailyResetApps.some((appId) => homeyDevice.driverId.includes(appId))) {
            device.settings.homey_device_daily_reset = true;
          }

          device.capabilities = this.capabilitiesFor(device.settings);

          if (!(homeyDevice.driverId.includes('com.gruijter.powerhour') // ignore own app devices
            || homeyDevice.driverId === 'homey')) { // ignore homey virtual power device
            listed.push({ device, score: PairSetup.listScore(this, homeyDevice, compatibility) });
          }
        }
      }

      // Likely sources first, then the virtual ones, and the devices to map manually last.
      devices.push(...PairSetup.sortByScore(listed.filter((entry) => entry.score > 0)));

      devices.push(...this.getVirtualDevices(randomId, allCaps, reducedCaps));

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
            tariff_update_group: 1,
            distribution: 'NONE',
          },
          capabilities: reducedCaps,
        },
      );

      devices.push(...PairSetup.sortByScore(listed.filter((entry) => entry.score === 0)));
      return devices;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  checkDeviceCompatibility(homeyDevice) {
    if (this.ds.requiredClass) {
      const deviceClass = homeyDevice.class;
      const { virtualClass } = homeyDevice;
      if (deviceClass !== this.ds.requiredClass && virtualClass !== this.ds.requiredClass) return { found: false };
    }

    let found = false;
    if (this.ds.originDeviceCapabilities && this.ds.originDeviceCapabilities.length > 0) {
      const hasCapability = (capability) => homeyDevice.capabilities.includes(capability);
      found = this.ds.originDeviceCapabilities.some(hasCapability);
    } else {
      found = true;
    }

    return { found, useMeasureSource: false };
  }

  getDeviceSettings(homeyDevice) {
    return {
      homey_device_id: homeyDevice.id,
      homey_device_name: homeyDevice.name,
      level: this.homey.app.manifest.version,
      source_device_type: 'Homey device',
      use_measure_source: false,
      tariff_update_group: 1,
      distribution: this.ds.defaultDistribution || 'NONE',
    };
  }

  getVirtualDevices(randomId, allCaps, reducedCaps) {
    return [];
  }

}

module.exports = SumMeterDriver;
