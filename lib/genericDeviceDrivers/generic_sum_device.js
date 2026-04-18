/* eslint-disable camelcase */
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

const { Device } = require('homey');
const crypto = require('crypto');
const Budget = require('../Budget');
const MeterHelpers = require('../MeterHelpers');
const SumFlows = require('../flows/SumFlows');
const DeviceMigrator = require('../DeviceMigrator');
const SourceDeviceHelper = require('../SourceDeviceHelper');
const { setTimeoutPromise } = require('../Util');

class SumMeterDevice extends Device {

  // this method is called when the Device is inited
  async onInit() {
    try {
      // init some stuff
      this.restarting = false;
      this.flows = new SumFlows(this);
      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.timeZone = this.homey.clock.getTimezone();
      this.settings = this.getSettings();

      if (!this.migrated) await this.migrate();
      if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);
      if (this.meterDecimalsChanged) await this.migrateMeterOptions(this.settings.decimals_meter);
      this.migrated = true;
      await this.setAvailable().catch((err) => this.error(err));

      // setup source for HOMEY-API devices with update listener
      if (this.settings.source_device_type === 'Homey device') {
        let api;
        try {
          api = this.homey.app.api;
        } catch (e) {
          // ignore
        }
        if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
        await this.getSourceDevice();
        // wait a bit for capabilitiesObj to fill?
        await setTimeoutPromise(3 * 1000, this);
        if (this.sessionId !== currentSessionId) return;
      } else this.log(this.getName(), 'Skipping setup of source device. Meter update is done via flow or from Homey Energy');

      // restore device values
      await this.initDeviceValues();

      if (this.sessionId !== currentSessionId) return;
      // init METER_VIA_FLOW device
      if (this.settings.source_device_type === 'virtual via flow') await this.updateMeterFromFlow(null);
      // start listener for METER_VIA_WATT device
      else if (this.settings.use_measure_source) {
        this.log(`Warning! ${this.getName()} is not using a cumulative meter as source`);
        await this.addListeners();
        await this.updateMeterFromMeasure(null);
        // start polling HOMEY_ENERGY device and HOMEY-API devices set to polling // this.settings.source_device_type === 'Homey Energy xxx'
      } else if (this.settings.interval) this.startPolling(this.settings.interval);
      // start listener for HOMEY-API device not set to polling
      else { // preferred realtime meter mode
        await this.addListeners();
        await this.pollMeter()
          .catch((error) => this.setUnavailable(error.message).catch((err) => this.error(err))); // do immediate forced update
      }
      this.initReady = true;
    } catch (error) {
      this.initReady = false; // retry after 5 minutes
      this.error(error);
      this.setUnavailable(error.message).catch(this.error);
    }
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    this.stopPolling();
    this.destroyListeners();
    let delay = 1500;
    if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
    await setTimeoutPromise(delay, this);
  }

  // migrate stuff from old version
  async migrate() {
    try {
      this.migrated = false;
      this.migrating = true;

      // check settings for homey energy
      if (this.settings.source_device_type.includes('Homey Energy')) {
        if (!this.settings.interval) {
          await this.setSettings({ interval: 1 }).catch((err) => this.error(err));
          this.settings = this.getSettings();
        }
        if (this.settings.use_measure_source) {
          await this.setSettings({ use_measure_source: false }).catch((err) => this.error(err));
          this.settings = this.getSettings();
        }
      }

      // check settings for for water and gas
      await this.ensureValidSettings();

      // check and repair incorrect capability(order)
      let correctCaps = this.driver.ds.deviceCapabilities;

      // remove meter_target_this_xxx caps  versions >5.0.2
      if (this.getSettings().distribution === 'NONE') correctCaps = correctCaps.filter((cap) => !cap.includes('meter_target'));
      const success = await DeviceMigrator.migrateCapabilities(this, correctCaps);
      if (!success) return Promise.resolve(false);

      // set new migrate level
      let version = '0.0.0';
      try {
        version = this.homey.app.manifest.version;
      } catch (e) {
        // ignore
      }
      await this.setSettings({ level: version }).catch((err) => this.error(err));
      this.settings = this.getSettings();
      this.migrating = false;
      return Promise.resolve(true);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
    }
  }

  async ensureValidSettings() {
    // Default implementation does nothing
  }

  async migrateCurrencyOptions(currency, decimals) {
    this.log('migrating money capability options');
    this.migrating = true;
    this.setUnavailable(this.homey.__('device_migrating')).catch((err) => this.error(err));

    // determine new units and decimals
    let curr = currency;
    let dec = decimals;
    const unit = this.getCurrencyUnit();
    if (!currency || currency === '') curr = '¤';
    if (!Number.isInteger(decimals)) dec = 2;

    const moneyOptions = {
      units: { en: curr },
      decimals: dec,
    };
    const tariffOptions = {
      units: { en: curr },
      decimals: 4,
    };
    const avgOptions = {
      units: { en: `${curr}/${unit}` },
      decimals: 4,
    };

    // migrate currency and decimals for money caps
    const moneyCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('money') && !name.includes('_avg'));
    for (let i = 0; i < moneyCaps.length; i += 1) {
      this.log('migrating money units and decimals', moneyCaps[i]);
      await this.setCapabilityOptions(moneyCaps[i], moneyOptions).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000, this);
    }
    // migrate currency and decimals for tariff
    this.log('migrating meter_tariff units and decimals');
    await this.setCapabilityOptions('meter_tariff', tariffOptions).catch((err) => this.error(err));
    await setTimeoutPromise(2 * 1000, this);
    // migrate currency and decimals for avg tariff
    if (this.hasCapability('meter_money_this_month_avg')) {
      this.log('migrating meter_money_this_month_avg units and decimals');
      await this.setCapabilityOptions('meter_money_this_month_avg', avgOptions).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000, this);

      this.log('migrating meter_money_this_year_avg units and decimals');
      await this.setCapabilityOptions('meter_money_this_year_avg', avgOptions).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000, this);

      try {
        const optsMoneyThisYearAvg = this.getCapabilityOptions('meter_money_this_year_avg');
        this.log('capability options migration ready', optsMoneyThisYearAvg);
      } catch (error) {
        this.error(`capability options migration has an error: ${error.message}`);
      }
    }
    this.currencyChanged = false;
    this.migrating = false;
  }

  getCurrencyUnit() {
    return 'kWh';
  }

  async migrateMeterOptions(decimals) {
    this.log('migrating meter capability options');
    this.migrating = true;
    this.setUnavailable(this.homey.__('device_migrating')).catch((err) => this.error(err));

    // determine new units and decimals
    let dec = decimals;
    if (!Number.isInteger(decimals)) dec = 4;

    const optionsKWh = {
      units: { en: 'kWh' },
      decimals: dec,
    };
    const optionM3 = {
      units: { en: 'm³' },
      decimals: dec,
    };

    const meterKWhCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_kwh'));
    for (let i = 0; i < meterKWhCaps.length; i += 1) {
      this.log('migrating decimals for', meterKWhCaps[i]);
      await this.setCapabilityOptions(meterKWhCaps[i], optionsKWh).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000, this);
    }
    if (this.hasCapability('meter_power')) {
      this.log('migrating decimals for meter_power');
      await this.setCapabilityOptions('meter_power', optionsKWh).catch((err) => this.error(err));
    }
    const meterM3Caps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_m3'));
    for (let i = 0; i < meterM3Caps.length; i += 1) {
      this.log('migrating decimals for', meterM3Caps[i]);
      await this.setCapabilityOptions(meterM3Caps[i], optionM3).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000, this);
    }
    if (this.hasCapability('meter_gas')) {
      this.log('migrating decimals for meter_gas');
      await this.setCapabilityOptions('meter_gas', optionM3).catch((err) => this.error(err));
    }
    if (this.hasCapability('meter_water')) {
      this.log('migrating decimals for meter_water');
      await this.setCapabilityOptions('meter_water', optionM3).catch((err) => this.error(err));
    }
    this.meterDecimalsChanged = false;
    this.migrating = false;
    this.log('meter capability options migration ready');
  }

  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    this.stopPolling();
    this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly, this).then(() => {
      if (!this.isDestroyed) this.onInit().catch((err) => this.error(err));
    });
  }

  // this method is called when the Device is added
  async onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
    if (this.shouldUpdateCurrencyOnAdd()) this.currencyChanged = true;
  }

  shouldUpdateCurrencyOnAdd() {
    return false;
  }

  // this method is called when the Device is deleted
  onDeleted() {
    this.stopPolling();
    this.destroyListeners();
    this.log(`Meter deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Meter renamed to: ${name}`);
  }

  // this method is called when the user has changed the device's settings in Homey.
  async onSettings({ newSettings, changedKeys }) {
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (this.lastReadingDay && this.lastReadingMonth && this.lastReadingYear) {
      if (changedKeys.includes('meter_day_start')) {
        this.lastReadingDay.meterValue = Number(newSettings.meter_day_start);
        await this.setStoreValue('lastReadingDay', this.lastReadingDay);
      }
      if (changedKeys.includes('meter_month_start')) {
        this.lastReadingMonth.meterValue = newSettings.meter_month_start;
        await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
      }
      if (changedKeys.includes('meter_year_start')) {
        this.lastReadingYear.meterValue = newSettings.meter_year_start;
        await this.setStoreValue('lastReadingYear', this.lastReadingYear);
      }
    }

    if (this.meterMoney) {
      const money = { ...this.meterMoney };
      if (changedKeys.includes('meter_money_this_day')) {
        money.day = newSettings.meter_money_this_day;
      }
      if (changedKeys.includes('meter_money_this_month')) {
        money.month = newSettings.meter_money_this_month;
      }
      if (changedKeys.includes('meter_money_this_year')) {
        money.year = newSettings.meter_money_this_year;
      }
      if (changedKeys.toString().includes('meter_money_last')) {
        money.lastDay = newSettings.meter_money_last_day;
        money.lastMonth = newSettings.meter_money_last_month;
        money.lastYear = newSettings.meter_money_last_year;
      }
      if (changedKeys.toString().includes('meter_money_')) {
        this.meterMoney = money;
        await this.setCapability('meter_money_last_day', money.lastDay);
        await this.setCapability('meter_money_last_month', money.lastMonth);
        await this.setCapability('meter_money_last_year', money.lastYear);
        await this.setCapability('meter_money_this_day', money.day);
        await this.setCapability('meter_money_this_month', money.month);
        await this.setCapability('meter_money_this_year', money.year);
        // Persist changes to settings so they survive restarts (since initDeviceValues reads from capabilities/settings)
        await this.setSettings({ meter_money_last_day: money.lastDay, meter_money_last_month: money.lastMonth, meter_money_last_year: money.lastYear }).catch((err) => this.error(err));
        await this.setSettings({ meter_money_this_day: money.day, meter_money_this_month: money.month, meter_money_this_year: money.year }).catch((err) => this.error(err));
      }
    }

    if (this.lastReadingMonth && this.lastReadingYear) {
      if (changedKeys.includes('start_date')) {
        let startDateString = newSettings.start_date;
        if (!startDateString || startDateString.length !== 4) startDateString = '0101';
        this.startDay = Number(startDateString.slice(0, 2));
        this.startMonth = Number(startDateString.slice(2, 4));
        if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
        if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
        this.startMonth -= 1;

        const now = new Date();
        const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
        const thisMonth = nowLocal.getMonth();
        const thisYear = nowLocal.getFullYear();
        this.lastReadingMonth.month = thisMonth;
        this.lastReadingYear.year = thisYear;
        await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
        await this.setStoreValue('lastReadingYear', this.lastReadingYear);
      }
    }

    if (this.tariffHistory) {
      if (changedKeys.includes('tariff')) {
        this.tariffHistory.current = newSettings.tariff;
        await this.setStoreValue('tariffHistory', this.tariffHistory);
      }
    }

    if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
      this.currencyChanged = true;
    }

    if (changedKeys.includes('budget')) {
      if ((newSettings.distribution && newSettings.distribution === 'CUSTOM')
        || (!newSettings.distribution && this.settings.distribution === 'CUSTOM')) {
        const d = newSettings.budget || this.getSettings().budget || '';
        const dist = d.split(';').map((month) => Number(month));
        const valid = (dist.length === 12) && dist.reduce((prev, cur) => prev && Number.isFinite(cur), true);
        if (!valid) throw Error(this.homey.__('error_budget_custom_12'));
      } else {
        const valid = Number.isFinite(Number(newSettings.budget));
        if (!valid) throw Error(this.homey.__('error_budget_invalid'));
      }
    }

    if (changedKeys.includes('distribution')) {
      this.migrated = false;
    }

    if (changedKeys.includes('decimals_meter')) {
      this.meterDecimalsChanged = true;
    }

    if (changedKeys.includes('tariff_update_group')) {
      this.driver.updateDeviceTariff(this, newSettings.tariff_update_group);
    }

    this.homey.setTimeout(() => {
      this.restartDevice(5000).catch((error) => this.error(error));
    }, 0);
    return Promise.resolve(true);
  }

  // EXECUTORS FOR ACTION FLOWS
  async runFlowAction(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Action ${id} not implemented`);
  }

  // EXECUTORS FOR CONDITION FLOWS
  async runFlowCondition(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Condition ${id} not implemented`);
  }

  // EXECUTORS FOR FLOW TRIGGERS
  async runFlowTrigger(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Trigger ${id} not implemented`);
  }

  destroyListeners() {
    if (this.capabilityInstances && Object.entries(this.capabilityInstances).length > 0) {
      Object.entries(this.capabilityInstances).forEach((entry) => {
        this.log(`Destroying capability listener ${entry[0]}`);
        entry[1].destroy();
      });
    }
    this.capabilityInstances = {};
  }

  async addSourceCapGroup() {
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters

    // 1. Try Homey generic energy object (useful for solar panels and batteries)
    if (this.sourceDevice.energy && this.sourceDevice.energy.meterPowerExportedCapability) {
      const cap = this.sourceDevice.energy.meterPowerExportedCapability;
      if (this.sourceDevice.capabilities.includes(cap)) {
        this.sourceCapGroup = {
          p1: cap, p2: null, n1: null, n2: null,
        };
        return;
      }
    }

    // 2. Try Driver specific capabilities
    if (this.driver.ds && this.driver.ds.sourceCapGroups) {
      this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
        const requiredKeys = Object.values(capGroup).filter((v) => v);
        return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
      });
      if (this.sourceCapGroup) return;
    }

    // 3. Fallback to single primary meter
    const fallbackMeter = this.ds.cmap.meter_source;
    if (this.sourceDevice.capabilities.includes(fallbackMeter)) {
      this.sourceCapGroup = {
        p1: fallbackMeter, p2: null, n1: null, n2: null,
      };
      return;
    }

    throw Error(`${this.sourceDevice.name} has no compatible ${fallbackMeter} capabilities ${this.sourceDevice.capabilities}`);
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    const meterCap = this.ds.cmap.meter_source;
    const targetMeasureCap = this.ds.cmap.measure_source;

    // start listener for METER_VIA_WATT device
    if (this.getSettings().use_measure_source) {
      if (this.sourceDevice.capabilities.includes('measure_power')) {
        this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
        this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          await this.updateMeterFromMeasure(value).catch(this.error);
        });
        return;
      }
      throw Error(`${this.sourceDevice.name} has no measure_power capability ${this.sourceDevice.capabilities}`);
    }

    // start listeners for HOMEY-API device
    await this.addSourceCapGroup();
    this.log(`registering ${meterCap} capability listener for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          this.lastGroupMeter[key] = value;
          await this.updateGroupMeter().catch(this.error);
        });
      }
    });

    // also listen to measure_power for better real-time updates and to prevent math spikes
    if (this.sourceDevice.capabilities.includes('measure_power')) {
      this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
        if (typeof value === 'number') {
          if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
          if (this.lastMinMax && this.lastMinMax.reading) {
            await this.checkMinMax(value, this.lastMinMax.reading);
          }
        }
      });
    }
  }

  async pollMeter() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      return;
    }
    if (!api) return;

    // poll a Homey Energy device
    if (this.getSettings().source_device_type.includes('Homey Energy')) {
      const report = await api.energy.getLiveReport().catch(this.error);
      if (report && this.settings.homey_energy && report[this.settings.homey_energy]) {
        const value = report[this.settings.homey_energy].W;
        await this.updateMeterFromMeasure(value).catch(this.error);
      }
      return;
    }

    // check if HOMEY-API source device has a defined capability group setup
    if (!this.sourceCapGroup) await this.addSourceCapGroup();

    // get all values for this.lastGroupMeter
    await this.getSourceDevice();
    Object.keys(this.sourceCapGroup)
      .filter((k) => this.sourceCapGroup[k])
      .forEach((k) => {
        if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[k]]) {
          this.lastGroupMeter[k] = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[k]].value;
        }
      });
    this.lastGroupMeterReady = true;
    await this.updateGroupMeter().catch(this.error);

    // also poll measure_power for better real-time updates
    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_power) {
      const rtValue = this.sourceDevice.capabilitiesObj.measure_power.value;
      if (typeof rtValue === 'number') {
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        if (this.lastMinMax && this.lastMinMax.reading) {
          await this.checkMinMax(rtValue, this.lastMinMax.reading);
        }
      }
    }
  }

  async updateGroupMeter() {
    // check if all GroupCaps have received their first value.
    if (!this.lastGroupMeterReady) {
      this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
      return;
    }
    // calculate the sum, and update meter
    let total = 0;
    let hasValue = false;
    if (Number.isFinite(this.lastGroupMeter.p1)) {
      total += this.lastGroupMeter.p1; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.p2)) {
      total += this.lastGroupMeter.p2; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.n1)) {
      total -= this.lastGroupMeter.n1; hasValue = true;
    }
    if (Number.isFinite(this.lastGroupMeter.n2)) {
      total -= this.lastGroupMeter.n2; hasValue = true;
    }
    if (hasValue) await this.updateMeter(total).catch(this.error);
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    if (this.intervalIdDevicePoll) {
      this.homey.clearInterval(this.intervalIdDevicePoll);
      this.homey.clearTimeout(this.intervalIdDevicePoll);
      this.intervalIdDevicePoll = null;
    }
  }

  startPolling(interval) {
    this.stopPolling();
    if (this.isDestroyed) return;
    this.log(`start polling ${this.getName()} @${interval} minutes interval`);
    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        await this.pollMeter();
      } catch (error) {
        this.error(error);
        this.setUnavailable(error.message || this.homey.__('polling_failed')).catch((err) => this.error(err));
        this.initReady = false; // restart within 5 minutes
      } finally {
        if (!this.isDestroyed) {
          this.intervalIdDevicePoll = this.homey.setTimeout(poll, 1000 * 60 * interval);
        }
      }
    };
    poll();
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      let val = value;
      if (capability === 'last_minmax_reset' && val) {
        const date = new Date(val);
        if (!Number.isNaN(date.getTime())) {
          val = date.toLocaleString('en-GB', { timeZone: this.timeZone, hour12: false });
        }
      }
      // only update changed capabilities
      if (val !== this.getCapabilityValue(capability)) {
        return this.setCapabilityValue(capability, val)
          .catch((error) => {
            this.error(error, capability, val);
          });
      }
    }
    return Promise.resolve();
  }

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async getReadingObject(value) {
    const date = new Date();
    return MeterHelpers.getReadingObject(value, date, this.timeZone);
  }

  async initDeviceValues() {
    if (!this.available) this.setAvailable().catch(this.error);
    this.log(`${this.getName()} Restoring device values after init`);

    // init tariffHistory
    if (!this.tariffHistory) this.tariffHistory = await this.getStoreValue('tariffHistory');
    if (!this.tariffHistory) {
      this.tariffHistory = {
        previous: null, // is still used just after newHour
        previousTm: null,
        current: this.settings.tariff,
        currentTm: new Date(), // time in UTC
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory);
    }

    // init incoming meter queue
    if (!this.newReadings) this.newReadings = [];

    // init daily resetting source devices
    if (!this.dayStartCumVal) this.dayStartCumVal = this.settings.meter_day_start;
    if (!this.cumVal) this.cumVal = this.dayStartCumVal;
    if (!this.lastAbsVal) this.lastAbsVal = 0;

    // init this.startDay, this.startMonth and this.year
    let startDateString = this.settings.start_date;
    if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
    this.startDay = Number(startDateString.slice(0, 2));
    this.startMonth = Number(startDateString.slice(2, 4));
    if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
    if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
    this.startMonth -= 1; // January is month 0

    // init this.budgets
    if (!this.budgets) this.budgets = this.getBudgets();

    // init this.lastReading
    if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
    if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
    if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

    // init this.lastMinMax
    if (!this.lastMinMax) this.lastMinMax = this.getStoreValue('lastMinMax');

    // PAIR init meter_power for use_measure_source
    const meterX = this.getCapabilityValue(this.ds.cmap.meter_source);
    if ((this.settings.use_measure_source || this.settings.homey_energy) && typeof meterX !== 'number') {
      this.log('meter kWh is set to 0 after device pair');
      await this.setCapability(this.ds.cmap.meter_source, 0);
    }

    // init this.lastMeasure
    if (!this.lastMeasure) {
      this.lastMeasure = {
        value: this.getCapabilityValue(this.ds.cmap.measure_source), // Can I restore measureTm from lastUpdated capabilityObj?
        measureTm: (this.lastMinMax && this.lastMinMax.reading) ? new Date(this.lastMinMax.reading.meterTm) : new Date(),
      };
      // PAIR init
      if (typeof this.lastMeasure.value !== 'number') this.lastMeasure.value = 0;
    }
    // assume 0 power when long time since last seen
    if ((new Date() - new Date(this.lastMeasure.measureTm)) > 300000) this.lastMeasure.value = 0;

    // init this.meterMoney
    if (!this.meterMoney) {
      this.meterMoney = {
        hour: this.getCapabilityValue('meter_money_this_hour'),
        day: this.getCapabilityValue('meter_money_this_day'),
        month: this.getCapabilityValue('meter_money_this_month'),
        year: this.getCapabilityValue('meter_money_this_year'),
        meterValue: this.getCapabilityValue(this.ds.cmap.meter_source), // current meter value.
        lastHour: this.getCapabilityValue('meter_money_last_hour'),
        lastDay: this.getCapabilityValue('meter_money_last_day'),
        lastMonth: this.getCapabilityValue('meter_money_last_month'),
        lastYear: this.getCapabilityValue('meter_money_last_year'),
      };
    }
  }

  // init some stuff when first reading comes in
  async initFirstReading({ ...reading }) {
    // check pair init
    const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
    if (pairInit) {
      this.log(`${this.getName()} Setting values after pair init`);
      await this.setStoreValue('lastReadingHour', reading);
      this.lastReadingHour = reading;
      const dayStart = this.settings.homey_device_daily_reset ? await this.getReadingObject(0) : reading;
      await this.setStoreValue('lastReadingDay', dayStart);
      this.lastReadingDay = dayStart;
      await this.setStoreValue('lastReadingMonth', reading);
      this.lastReadingMonth = reading;
      await this.setStoreValue('lastReadingYear', reading);
      this.lastReadingYear = reading;
      // set meter start in device settings
      await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch((err) => this.error(err));
      await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue }).catch((err) => this.error(err));
      await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue }).catch((err) => this.error(err));
      await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue }).catch((err) => this.error(err));
    }
    // pair init Money
    if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
    // pair init minMax
    if (!this.lastMinMax) { // pair init
      this.lastMinMax = {
        reading,
        wattMax: null,
        lpmMax: null,
        wattMin: null,
        lpmMin: null,
        reset: null,
      };
      await this.flows.minmax_reset({ reset: true, source: 'pairInit' });
    }
    this.initReady = true;
  }

  // update the tariff from flow or DAP
  async updateTariffHistory(tariff, currentTm) {
    try {
      if (!this.migrated || !this.tariffHistory) {
        this.log('device is not ready. Ignoring new tariff!');
        return;
      }
      const tariffHistory = {
        previous: this.tariffHistory.current,
        previousTm: this.tariffHistory.currentTm,
        current: tariff,
        currentTm,
      };
      this.tariffHistory = tariffHistory;
      const activeTariff = this.getActiveTariff({ meterValue: this.meterMoney?.meterValue || 0 }, tariff, tariff);
      await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));
      this.setSettings({ tariff }).catch((err) => this.error(err));
      await this.setStoreValue('tariffHistory', tariffHistory);
    } catch (error) {
      this.error(error);
    }
  }

  async updateGridTariffs(currentTm) {
    try {
      if (!this.migrated || !this.tariffHistory) return;

      const s = this.getSettings();
      const updateGroup = s.tariff_update_group;

      const driverTariffs = this.driver.tariffs || {};
      const driverExportTariffs = this.driver.exportTariffs || {};
      const driverCurrencies = this.driver.currencies || {};

      let purchaseTariff = driverTariffs[updateGroup];
      if (purchaseTariff === undefined) purchaseTariff = this.tariffHistory.current;

      let exportTariff = driverExportTariffs[updateGroup];
      if (exportTariff === undefined) exportTariff = purchaseTariff;

      const currency = driverCurrencies[updateGroup];
      if (currency && s.currency === '') {
        this.log(`Auto-setting currency to ${currency} from DAP source`);
        await this.setSettings({ currency }).catch((err) => this.error(err));
        this.currencyChanged = true;
      }

      const tariffHistory = {
        previous: this.tariffHistory.current,
        previousExport: this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : this.tariffHistory.current,
        previousTm: this.tariffHistory.currentTm,
        current: purchaseTariff,
        currentExport: exportTariff,
        currentTm,
      };

      this.tariffHistory = tariffHistory;
      const activeTariff = this.getActiveTariff({ meterValue: this.meterMoney?.meterValue || 0 }, purchaseTariff, exportTariff);
      await this.setCapability('meter_tariff', activeTariff).catch(this.error);
      this.setSettings({ tariff: purchaseTariff }).catch(this.error);
      await this.setStoreValue('tariffHistory', tariffHistory);
    } catch (error) {
      this.error(error);
    }
  }

  async handleUpdateMeter(reading) {
    try {
      const periods = this.getPeriods(reading); // check for new hour/day/month/year
      await this.updateMeters(reading, periods);
      await this.updateTargets(periods);
      await this.updateMoney(reading, periods);
      await this.updateAvgMoney(periods);
      await this.updateMeasureMinMax(reading, periods);
    } catch (error) {
      this.error(error);
    }
  }

  async updateMeter(val) {
    try {
      if (typeof val !== 'number') {
        this.log(`Ignoring invalid meter value: ${val} (${typeof val})`);
        return;
      }
      if (!this.migrated || this.currencyChanged) return;
      let value = val;
      // logic for daily resetting meters
      if (this.settings.homey_device_daily_reset) {
        // detect reset
        const absVal = Math.abs(value);
        const reset = ((absVal < this.lastAbsVal) && (absVal < 0.1));
        this.lastAbsVal = absVal;
        if (reset) {
          this.log('source device meter reset detected');
          this.dayStartCumVal = this.cumVal;
          await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue }).catch((err) => this.error(err));
          this.cumVal += absVal;
        } else {
          this.cumVal = this.dayStartCumVal + absVal;
        }
        value = this.cumVal;
      }

      // filter unrealistic meter values. note: delta depends on metertype?
      const lastVal = this.getCapabilityValue(this.ds.cmap.meter_source);
      const meterDelta = Math.abs(value - lastVal);
      if ((lastVal !== null) && (lastVal > 1) && (meterDelta > 10000)) throw Error(`ignoring unrealistic incoming meter value! ${value} (prev: ${lastVal})`);

      // create a readingObject from value
      const reading = await this.getReadingObject(value);
      if (!this.initReady || !this.lastReadingYear) await this.initFirstReading(reading); // after app start
      // Put values in queue
      if (!this.newReadings) this.newReadings = [];
      this.newReadings.push(reading);

      if (this.processingReadings) return;
      this.processingReadings = true;
      try {
        while (this.newReadings.length > 0) {
          const newReading = this.newReadings.shift();
          await this.handleUpdateMeter(newReading);
        }
      } finally {
        this.processingReadings = false;
      }
    } catch (error) {
      this.error(error);
    }
  }

  async updateMeterFromFlow(args) {
    if (!this.migrated || this.currencyChanged) return;
    let value = null;
    if (args && args.value !== undefined) value = args.value;
    else if (typeof args === 'number') value = args;

    if (value === null) { // poll requested
      value = this.getCapabilityValue(this.ds.cmap.meter_source);
      if (value === null) return;
    }
    await this.updateMeter(value);
  }

  // takes Watt, creates kWh metervalue
  async updateMeterFromMeasure(val) {
    if (!this.migrated || this.currencyChanged) return;
    const measureTm = new Date();
    let value = val;
    if (value === null && !this.settings.source_device_type.includes('Homey Energy')) { // poll requested or app init
      // get value from source device
      if (this.sourceDevice && this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.measure_power) {
        value = this.sourceDevice.capabilitiesObj.measure_power.value;
      }
    }
    if (typeof value !== 'number') return;
    const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);

    const lastMeterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
    if (typeof lastMeterValue !== 'number') {
      this.error('lastMeterValue is NaN, WTF');
      return;
    }
    if (typeof deltaTm !== 'number' || deltaTm === 0) {
      this.error('deltaTm is NaN, WTF');
      return;
    }
    const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
    const meter = lastMeterValue + deltaMeter;
    this.lastMeasure = {
      value,
      measureTm,
    };
    await this.updateMeter(meter);
  }

  getPeriods(reading) {
    return MeterHelpers.getPeriods(
      reading,
      this.lastReadingHour,
      this.lastReadingDay,
      this.lastReadingMonth,
      this.lastReadingYear,
      this.startDay,
      this.startMonth,
    );
  }

  getBudgets() {
    if (!this.settings.distribution || this.settings.distribution === 'NONE') return null;

    const date = new Date();
    const dateLocal = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));
    const yearLocal = dateLocal.getFullYear();
    const startOfMonth = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));
    startOfMonth.setDate(this.startDay); // first day of this month
    const soyDayNr = Budget.getDayOfYear(new Date(yearLocal, this.startMonth, this.startDay)); // start of this year 1 - 366
    const somDayNr = Budget.getDayOfYear(startOfMonth); // start of this month 1 - 366
    const nowDayNr = Budget.getDayOfYear(dateLocal); // start of this day 1 - 366

    const monthToDate = Budget.getBudget(this.settings.distribution, this.settings.budget, nowDayNr, somDayNr);
    const yearToDate = Budget.getBudget(this.settings.distribution, this.settings.budget, nowDayNr, soyDayNr);
    return { monthToDate, yearToDate };
  }

  async updateMeters({ ...reading }, { ...periods }) {
    await this.setCapability(this.ds.cmap.meter_source, reading.meterValue).catch((err) => this.error(err));
    // temp copy this.lastReadingX
    let lastReadingHour = { ...this.lastReadingHour };
    let lastReadingDay = { ...this.lastReadingDay };
    let lastReadingMonth = { ...this.lastReadingMonth };
    let lastReadingYear = { ...this.lastReadingYear };
    // calculate meters
    let valHour = reading.meterValue - lastReadingHour.meterValue;
    let valDay = reading.meterValue - lastReadingDay.meterValue;
    let valMonth = reading.meterValue - lastReadingMonth.meterValue;
    let valYear = reading.meterValue - lastReadingYear.meterValue;
    // set capabilities
    if (periods.newHour) {
      // new hour started
      await this.setCapability(this.ds.cmap.last_hour, valHour).catch((err) => this.error(err));
      lastReadingHour = reading;
      await this.setStoreValue('lastReadingHour', reading);
      await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch((err) => this.error(err));
      valHour = 0;

      const meterCharging = await this.getCapabilityValue('meter_kwh_charging');
      const meterDischarging = await this.getCapabilityValue('meter_kwh_discharging');
      if (meterCharging) await this.setSettings({ meter_kwh_charging: meterCharging }).catch((err) => this.error(err));
      if (meterDischarging) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch((err) => this.error(err));
    }
    if (periods.newDay) {
      // new day started
      await this.setCapability(this.ds.cmap.last_day, valDay).catch((err) => this.error(err));
      lastReadingDay = reading;
      await this.setStoreValue('lastReadingDay', reading);
      await this.setSettings({ meter_day_start: lastReadingDay.meterValue }).catch((err) => this.error(err));
      valDay = 0;
    }
    if (periods.newMonth) {
      // new month started
      await this.setCapability(this.ds.cmap.last_month, valMonth).catch((err) => this.error(err));
      lastReadingMonth = reading;
      await this.setStoreValue('lastReadingMonth', reading);
      await this.setSettings({ meter_month_start: lastReadingMonth.meterValue }).catch((err) => this.error(err));
      valMonth = 0;
    }
    if (periods.newYear) {
      // new year started
      await this.setCapability(this.ds.cmap.last_year, valYear).catch((err) => this.error(err));
      lastReadingYear = reading;
      await this.setStoreValue('lastReadingYear', reading);
      await this.setSettings({ meter_year_start: lastReadingYear.meterValue }).catch((err) => this.error(err));
      valYear = 0;
    }

    await this.setCapability(this.ds.cmap.this_hour, valHour).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_day, valDay).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_month, valMonth).catch((err) => this.error(err));
    await this.setCapability(this.ds.cmap.this_year, valYear).catch((err) => this.error(err));
    // store this.lastReadingX
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
  }

  async updateTargets({ ...periods }) {
    // update tariff capability
    if (!this.settings.distribution || this.settings.distribution === 'NONE') return;
    if (periods.newDay) this.budgets = this.getBudgets();
    if (this.budgets && this.budgets.yearToDate) {
      const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_year) / this.budgets.yearToDate);
      await this.setCapability('meter_target_year_to_date', onTarget).catch((err) => this.error(err));
    }
    if (this.budgets && this.budgets.monthToDate) {
      const onTarget = 100 * (this.getCapabilityValue(this.ds.cmap.this_month) / this.budgets.monthToDate);
      await this.setCapability('meter_target_month_to_date', onTarget).catch((err) => this.error(err));
    }
  }

  getActiveTariff(reading, tariff, exportTariff) {
    return tariff; // Default for non-exporting devices (gas, water)
  }

  async updateMoney({ ...reading }, { ...periods }) {
    let tariff = this.tariffHistory.current;
    let exportTariff = this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : tariff;

    // If this reading marks a new hour, we need the tariff of the PREVIOUS hour to calculate the cost of the accumulated energy.
    if (periods.newHour && this.tariffHistory && this.tariffHistory.currentTm) {
      const currentTariffDate = new Date(this.tariffHistory.currentTm);
      const readingDate = new Date(reading.meterTm);
      const startOfReadingHour = new Date(readingDate);
      startOfReadingHour.setMinutes(0, 0, 0);

      // If current tariff was updated AT OR AFTER the start of the reading's hour, we must fallback to the previous tariff.
      if (currentTariffDate.getTime() >= startOfReadingHour.getTime()) {
        tariff = this.tariffHistory.previous;
        exportTariff = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : tariff;
      }
    }

    const activeTariff = this.getActiveTariff(reading, tariff, exportTariff);

    if (activeTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));

    // calculate money
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff);

    let fixedMarkup = 0;
    if (periods.newHour) {
      // new hour started
      meterMoney.lastHour = meterMoney.hour;
      meterMoney.hour = 0;
      fixedMarkup += (this.getSettings().markup_hour || 0);
      await this.setCapability('meter_money_last_hour', meterMoney.lastHour);
      await this.setSettings({ meter_money_last_hour: meterMoney.lastHour }).catch((err) => this.error(err));
    }
    if (periods.newDay) {
      // new day started
      meterMoney.lastDay = meterMoney.day;
      meterMoney.day = 0;
      fixedMarkup += (this.getSettings().markup_day || 0);
      await this.setCapability('meter_money_last_day', meterMoney.lastDay);
      await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch((err) => this.error(err));
    }
    if (periods.newMonth) {
      // new month started
      meterMoney.lastMonth = meterMoney.month;
      meterMoney.month = 0;
      fixedMarkup += (this.getSettings().markup_month || 0);
      await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
      await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch((err) => this.error(err));
    }
    if (periods.newYear) {
      // new year started
      meterMoney.lastYear = meterMoney.year;
      meterMoney.year = 0;
      await this.setCapability('meter_money_last_year', meterMoney.lastYear);
      await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch((err) => this.error(err));
    }
    // add fixed markups
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;
    // update money_this_x capabilities
    await this.setCapability('meter_money_this_hour', meterMoney.hour);
    await this.setCapability('meter_money_this_day', meterMoney.day);
    await this.setCapability('meter_money_this_month', meterMoney.month);
    await this.setCapability('meter_money_this_year', meterMoney.year);
    this.meterMoney = meterMoney;
    // Update settings every hour
    if (periods.newHour) {
      await this.setSettings({ meter_money_this_day: meterMoney.day }).catch((err) => this.error(err));
      await this.setSettings({ meter_money_this_month: meterMoney.month }).catch((err) => this.error(err));
      await this.setSettings({ meter_money_this_year: meterMoney.year }).catch((err) => this.error(err));
    }
  }

  async updateAvgMoney() {
    // update avg money / kWh_m3
    const moneyThisMonth = this.meterMoney.month;
    const meterThisMonth = this.getCapabilityValue(this.ds.cmap.this_month);
    if (meterThisMonth) await this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth).catch((err) => this.error(err));

    const moneyThisYear = this.meterMoney.year;
    const meterThisYear = this.getCapabilityValue(this.ds.cmap.this_year);
    if (meterThisYear) await this.setCapability('meter_money_this_year_avg', moneyThisYear / meterThisYear).catch((err) => this.error(err));
  }

  async updateMeasureMinMax({ ...reading }, { ...periods }) {
    // reset min/max based on device settings
    if ((periods.newHour && this.settings.min_max_reset === 'hour') || (periods.newDay && this.settings.min_max_reset === 'day')
      || (periods.newMonth && this.settings.min_max_reset === 'month')
      || (periods.newYear && this.settings.min_max_reset === 'year')) {
      await this.flows.minmax_reset({ reset: true, source: 'device settings' });
    }
    // minimal 2 minutes avg needed
    const deltaTm = new Date(reading.meterTm) - new Date(this.lastMinMax.reading.meterTm);
    const deltaMeter = reading.meterValue - this.lastMinMax.reading.meterValue;

    // Skip math-based trend if we have real-time power updates (prevents artificial spikes)
    if (this.capabilityInstances && this.capabilityInstances.measurePowerRealtime) {
      this.lastMinMax.reading = reading;
      await this.setStoreValue('lastMinMax', this.lastMinMax);
      return;
    }

    if (deltaTm < 119000) return;
    // calculate current avg use
    const measureValue = this.calculateMeasureTrend(deltaMeter, deltaTm);
    await this.setCapability(this.ds.cmap.measure_source, measureValue).catch((err) => this.error(err));
    // check for new max/min values
    await this.checkMinMax(measureValue, reading);
  }

  calculateMeasureTrend(deltaMeter, deltaTm) {
    // Default to Power (kWh -> Watt)
    return Math.round((3600000000 / deltaTm) * deltaMeter);
  }

  async checkMinMax(val, reading) {
    const { wattMax, wattMin } = this.lastMinMax;

    if (wattMax === null || val > wattMax) this.lastMinMax.wattMax = val;
    if (wattMin === null || val < wattMin) this.lastMinMax.wattMin = val;

    this.lastMinMax.reading = reading;
    // update min/max capabilities
    if (this.minMaxInitReady) { // skip first interval after app start NEEDED BECAUSE OF POLLING NOT KNOWING CORRECT TIMESTAMP!!!
      await this.setCapability('measure_watt_max', this.lastMinMax.wattMax).catch((err) => this.error(err));
      await this.setCapability('measure_watt_min', this.lastMinMax.wattMin).catch((err) => this.error(err));
    } else this.log('Skipping first min/max interval for', this.getName());

    this.minMaxInitReady = true;
    await this.setStoreValue('lastMinMax', this.lastMinMax);
  }

}

module.exports = SumMeterDevice;
