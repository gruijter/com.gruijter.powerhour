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
const PriceShift = require('../helpers/PriceShift');
const PriceIntervalGroups = require('../helpers/PriceIntervalGroups');
const MeterHelpers = require('../helpers/MeterHelpers');
const PairSetup = require('../helpers/PairSetup');
const MoneyUnit = require('../helpers/MoneyUnit');
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
          // every15m_PBTH skips the full hour: here the new price slot's tariff (see register15mListener()).
          await runExclusive(`tariff|${this.id}`, () => this.priceSlotTickExclusive());
          // All driver types fire on this event: a random jitter spreads their update loops (a burst of
          // Insights fetches and chart rebuilds has pushed the process over its memory limit).
          await setTimeoutPromise(Math.random() * 8000, this);
          const devices = this.getDevices();
          for (const device of devices) {
            await device.updateWarning().catch((err) => this.error(err));
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
          // First, without jitter, the tariff of a new price slot from the lists (flows read it).
          await runExclusive(`tariff|${this.id}`, () => this.priceSlotTickExclusive());
          // Jitter, see registerHourlyListener().
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

  // Also awaited directly by the "Set Tariff" flow card, so the next card does not race the
  // device writes. Serialized per driver, as in generic_bat_driver (see runExclusive() in Util.js).
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

    // Finest declared interval wins (lib/helpers/PriceIntervalGroups.js).
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
    this.moneyUnits = this.moneyUnits || {};
    this.pricesNextHours = this.pricesNextHours || {};
    this.exportPricesNextHours = this.exportPricesNextHours || {};
    this.pricesNextHoursMarketLength = this.pricesNextHoursMarketLength || {};
    this.pricesNextHours[group] = args.pricesNextHours;
    this.exportPricesNextHours[group] = args.exportPricesNextHours;
    this.pricesNextHoursMarketLength[group] = args.pricesNextHoursMarketLength;
    this.pricesStartTms = this.pricesStartTms || {};
    this.pricesStartTms[group] = args.pricesStartTm; // none for a tariff set by flow
    // The list's own interval: the group's (finest of its sources) can differ with mixed sources.
    this.listIntervals = this.listIntervals || {};
    this.listIntervals[group] = Number(args.priceInterval) > 0 ? Number(args.priceInterval) : priceInterval;

    this.tariffs[group] = tariff;
    this.exportTariffs[group] = exportTariff;
    this.priceIntervals[group] = priceInterval;
    this.moneyUnits[group] = MoneyUnit.fromPrices(args);

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

    const { tariff, exportTariff } = this.currentTariff(updateGroup);
    const priceInterval = this.priceIntervals ? this.priceIntervals[updateGroup] : 60;
    const args = {
      pricesNextHours: this.pricesNextHours ? this.pricesNextHours[updateGroup] : null,
      exportPricesNextHours: this.exportPricesNextHours ? this.exportPricesNextHours[updateGroup] : null,
      pricesNextHoursMarketLength: this.pricesNextHoursMarketLength ? this.pricesNextHoursMarketLength[updateGroup] : null,
      priceInterval,
      currency: this.moneyUnits && this.moneyUnits[updateGroup] ? this.moneyUnits[updateGroup].currency : null,
      moneyDecimals: this.moneyUnits && this.moneyUnits[updateGroup] ? this.moneyUnits[updateGroup].decimals : null,
    };
    // Awaited: runExclusive() releases the lock when this method resolves.
    await device.updateTariffHistory(tariff, new Date(), priceInterval, exportTariff, args);
  }

  // The group's tariff now: from its price list (the broadcast can be hours old), else as received.
  currentTariff(group) {
    const fromList = PriceShift.priceNow({
      prices: this.pricesNextHours && this.pricesNextHours[group],
      exportPrices: this.exportPricesNextHours && this.exportPricesNextHours[group],
      startTm: this.pricesStartTms && this.pricesStartTms[group],
      interval: (this.listIntervals && this.listIntervals[group]) || (this.priceIntervals && this.priceIntervals[group]),
    }, this.homey.clock.getTimezone());
    if (fromList) return fromList;
    const tariff = this.tariffs[group];
    return { tariff, exportTariff: this.exportTariffs ? this.exportTariffs[group] : tariff };
  }

  // A new price slot: each device in a group with a price list gets its tariff, without a broadcast.
  async priceSlotTickExclusive() {
    if (!this.pricesStartTms) return;
    const tz = this.homey.clock.getTimezone();
    const now = Date.now();
    for (const device of this.getDevices()) {
      const group = device.settings && device.settings.tariff_update_group;
      const history = device.tariffHistory;
      if (!group || !Number.isFinite(this.pricesStartTms[group]) || !history || !history.currentTm) continue;
      const interval = this.priceIntervals[group] || 60;
      if (!PriceShift.isNewSlot(history.currentTm, interval, tz, now)) continue;
      const { tariff, exportTariff } = this.currentTariff(group);
      if (!Number.isFinite(tariff)) continue;
      await device.updateTariffHistory(tariff, new Date(now), interval, exportTariff, null).catch((err) => device.error(err));
    }
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

  onRepair(session, device) {
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
    const roles = ((this.ds.setup && this.ds.setup.roles) || []).filter((role) => !role.watt).map((role) => role.key);
    const group = SourceCaps.applyChoice(sourceDevice, auto, roles, SourceCaps.chosenFor(stored, sourceDevice.id));
    return Object.values(group).some((v) => v) ? group : null;
  }

  // Watt as source: the power capability chosen in the setup view, else measure_power, or null.
  wattCapFor(sourceDevice, stored) {
    const caps = sourceDevice.capabilities || [];
    const chosen = SourceCaps.chosenFor(stored, sourceDevice.id).watt;
    if (chosen && chosen !== 'auto' && chosen !== 'none' && caps.includes(chosen)) return chosen;
    return caps.includes('measure_power') ? 'measure_power' : null;
  }

  // Homey Energy and flow devices have no source device settings, and are no program appliance.
  setupSettings(dev) {
    const ids = this.ds.setup.settings;
    if (dev.settings.source_device_type === 'Homey device') return ids;
    return ids.filter((id) => !['use_measure_source', 'homey_device_daily_reset', 'forecast_appliance'].includes(id));
  }

  async _setupSourceDevice(settings) {
    if (!(this.ds.setup && this.ds.setup.roles) || settings.source_device_type !== 'Homey device') return null;
    return PairSetup.apiDevice(this, settings.homey_device_id);
  }

  // Setup view: per meter role (ds.setup.roles) the capabilities of the source device. A watt
  // role is shown with "Use Watt as source" (mode 'watt'), the meter roles without (mode 'meter').
  async setupRoles(dev, stored) {
    const source = await this._setupSourceDevice(dev.settings);
    if (!source) return null;
    const auto = { ...(this.autoSourceCapGroup(source) || {}), watt: (source.capabilities || []).includes('measure_power') ? 'measure_power' : null };
    const roles = this.ds.setup.roles.map((role) => ({ ...role, label: this.homey.__(`repair.setup_role_${role.label || role.key}`) }));
    // An optional role only when the source may fill it: detected, chosen before, or a second
    // capability of its kind. A hidden role stays automatic, which is none then.
    const items = SourceCaps.roleItems(source, roles, auto, SourceCaps.chosenFor(stored, source.id))
      .map((item, i) => ({ ...item, mode: roles[i].watt ? 'watt' : 'meter', noNone: !!roles[i].watt }))
      .filter((item, i) => !roles[i].optional || item.auto || item.selected !== 'auto' || item.options.length > 1);
    return {
      deviceId: source.id,
      title: this.homey.__('repair.setup_caps_title'),
      text: `${source.name}. ${this.homey.__('repair.setup_caps_text')}`,
      items,
    };
  }

  // Watt needs a power capability, else at least one meter capability.
  async setupValidate(settings, caps) {
    const source = await this._setupSourceDevice(settings);
    if (!source) return;
    if (settings.use_measure_source) {
      if (!this.wattCapFor(source, { sourceId: source.id, caps })) {
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
            name: PairSetup.listName(this, homeyDevice.name, compatibility),
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
          name: 'VIRTUAL_VIA_FLOW',
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
