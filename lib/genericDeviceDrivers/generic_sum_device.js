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
const MeterHelpers = require('../helpers/MeterHelpers');
const SumFlows = require('../flows/SumFlows');
const DeviceMigrator = require('../DeviceMigrator');
const SourceDeviceHelper = require('../helpers/SourceDeviceHelper');
const { setTimeoutPromise } = require('../helpers/Util');

class SumMeterDevice extends Device {

  async onInit() {
    try {
      this.restarting = false;
      if (!this.flows) this.flows = new SumFlows(this);
      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.timeZone = this.homey.clock.getTimezone();
      this.settings = this.getSettings();

      if (!this.migrated) await this.migrate();

      await DeviceMigrator.checkCurrencyMismatch(this, this.settings.currency, '¤');

      if (this.currencyChanged) await DeviceMigrator.migrateCurrencyOptions(this, this.settings.currency, this.settings.decimals, '¤', this.getCurrencyUnit());
      if (this.meterDecimalsChanged) await DeviceMigrator.migrateMeterOptions(this, this.settings.decimals_meter);
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

      await this.initDeviceValues();

      if (this.sessionId !== currentSessionId) return;
      // init METER_VIA_FLOW device
      if (this.settings.source_device_type === 'virtual via flow') await this.updateMeterFromFlow(null);
      // start listener for METER_VIA_WATT device
      else if (this.settings.use_measure_source) {
        this.log(`Warning! ${this.getName()} is not using a cumulative meter as source`);
        await this.addListeners();
        await this.updateMeterFromMeasure(null);
        // start polling HOMEY_ENERGY device and HOMEY-API devices set to polling
      } else if (this.settings.interval) this.startPolling(this.settings.interval);
      // start listener for HOMEY-API device not set to polling
      else { // preferred realtime meter mode
        await this.addListeners();
        await this.pollMeter()
          .catch((error) => this.setUnavailable(error.message).catch((err) => this.error(err))); // do immediate forced update
      }

      // Trigger lazy driver polling if deferred
      if (typeof this.driver.checkStartPolling === 'function') {
        await this.driver.checkStartPolling();
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

  async migrate() {
    try {
      this.migrated = false;
      this.migrating = true;

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

      // check settings for water and gas
      await this.ensureValidSettings();

      let correctCaps = this.driver.ds.deviceCapabilities;

      // remove meter_target_this_xxx caps  versions >5.0.2
      if (this.getSettings().distribution === 'NONE') correctCaps = correctCaps.filter((cap) => !cap.includes('meter_target'));
      const success = await DeviceMigrator.migrateCapabilities(this, correctCaps);
      if (!success) return Promise.resolve(false);

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

  getCurrencyUnit() {
    if (this.driver.ds && (this.driver.ds.driverId === 'gas' || this.driver.ds.driverId === 'water')) return 'm³';
    return 'kWh';
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

  async onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
    if (this.shouldUpdateCurrencyOnAdd()) this.currencyChanged = true;

    // Fetch the active tariff from the DAP driver cache immediately after pairing
    if (this.driver.updateDeviceTariff) {
      this.homey.setTimeout(() => {
        if (!this.isDestroyed) this.driver.updateDeviceTariff(this);
      }, 3000);
    }
  }

  shouldUpdateCurrencyOnAdd() {
    return false;
  }

  onDeleted() {
    this.stopPolling();
    this.destroyListeners();
    this.log(`Meter deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Meter renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (this.lastReadingDay && this.lastReadingMonth && this.lastReadingYear) {
      // A manually entered start value above the live meter reading would make the
      // corresponding this_day/this_month/this_year total go (and stay) negative until the
      // next natural rollover - reject it up front instead of silently accepting it.
      const currentMeterValue = this.getCapabilityValue(this.ds.cmap.meter_source);
      // A meter reading below zero only ever counts DOWN (e.g. solar/export wired negative),
      // so there the period start must sit ABOVE the live reading - the exact opposite of a
      // normal upward counting meter. Applying the upward rule to those made every correct
      // start value unenterable. See issue #353.
      const countsDown = typeof currentMeterValue === 'number' && currentMeterValue < 0;
      const validateStart = (raw) => {
        const val = Number(raw);
        if (!Number.isFinite(val)) throw Error(this.homey.__('error_value_not_number'));
        if (typeof currentMeterValue === 'number') {
          const invalid = countsDown ? val < currentMeterValue : val > currentMeterValue;
          if (invalid) throw Error(this.homey.__('error_meter_start_invalid'));
        }
        return val;
      };
      if (changedKeys.includes('meter_day_start')) {
        this.lastReadingDay.meterValue = validateStart(newSettings.meter_day_start);
        await this.setStoreValue('lastReadingDay', this.lastReadingDay);
      }
      if (changedKeys.includes('meter_month_start')) {
        this.lastReadingMonth.meterValue = validateStart(newSettings.meter_month_start);
        await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
      }
      if (changedKeys.includes('meter_year_start')) {
        this.lastReadingYear.meterValue = validateStart(newSettings.meter_year_start);
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
    this.lastGroupMeter = {};

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
          // Feed min/max directly from this real-time push (same as the HOMEY-API device's
          // measurePowerRealtime listener below) rather than relying solely on
          // updateMeterFromMeasure() -> updateMeasureMinMax()'s 2-minute-averaged trend calc -
          // this source is already streaming instantaneous power, so min/max shouldn't be
          // smoothed just because it happens to also be the primary meter source.
          if (typeof value === 'number' && this.lastMinMax && this.lastMinMax.reading) {
            await this.checkMinMax(value, this.lastMinMax.reading).catch(this.error);
          }
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
            await this.checkMinMax(value, this.lastMinMax.reading).catch(this.error);
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
          await this.checkMinMax(rtValue, this.lastMinMax.reading).catch(this.error);
        }
      }
    }
  }

  async updateGroupMeter() {
    if (!this.lastGroupMeterReady) {
      this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
      return;
    }
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
        previousExport: null,
        current: this.settings.tariff,
        currentExport: this.settings.tariff, // This will be safely overridden by the DAP broadcast, but prevents NaN math
        currentTm: new Date(), // time in UTC
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory);
    }

    // init priceInterval for correct 15m/60m polling boundary
    if (!this.priceInterval) this.priceInterval = await this.getStoreValue('priceInterval') || 60;

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
    if (!this.lastMinMax) this.lastMinMax = await this.getStoreValue('lastMinMax');

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

  async initFirstReading({ ...reading }) {
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
      await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch((err) => this.error(err));
      await this.setSettings({ meter_day_start: this.lastReadingDay.meterValue }).catch((err) => this.error(err));
      await this.setSettings({ meter_month_start: this.lastReadingMonth.meterValue }).catch((err) => this.error(err));
      await this.setSettings({ meter_year_start: this.lastReadingYear.meterValue }).catch((err) => this.error(err));
    }
    if (this.meterMoney && !this.meterMoney.meterValue) this.meterMoney.meterValue = reading.meterValue;
    // pair init minMax - three independently-resetting period trackers, see checkMinMax() below.
    // Also re-inits for an EXISTING device whose stored lastMinMax still has the old single-pair
    // shape ({wattMax, wattMin, reading, reset} - no .day/.month/.year), otherwise checkMinMax()
    // would crash reading properties off undefined the first time it runs post-upgrade.
    if (!this.lastMinMax || !this.lastMinMax.day || !this.lastMinMax.month || !this.lastMinMax.year) {
      this.lastMinMax = {
        reading,
        day: {
          min: null, max: null, day: null, month: null,
        },
        month: {
          min: null, max: null, month: null, year: null,
        },
        year: { min: null, max: null, year: null },
      };
      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error(err));
    }
    this.initReady = true;
    this.firstReadingDone = true;
  }

  // update the tariff from flow or DAP
  async updateTariffHistory(tariff, currentTm, priceInterval, exportTariff, args) {
    try {
      if (!this.migrated || !this.tariffHistory) {
        this.log('device is not ready. Ignoring new tariff!');
        return;
      }
      this.priceInterval = priceInterval || 60;
      const exportT = exportTariff !== undefined ? exportTariff : tariff;

      let crossedBoundary = true;
      if (this.tariffHistory && this.tariffHistory.currentTm) {
        const lastTm = new Date(this.tariffHistory.currentTm);
        const pInt = this.priceInterval;
        const lastBoundary = new Date(lastTm);
        lastBoundary.setUTCMinutes(Math.floor(lastTm.getUTCMinutes() / pInt) * pInt, 0, 0);
        const currentBoundary = new Date(currentTm);
        currentBoundary.setUTCMinutes(Math.floor(currentBoundary.getUTCMinutes() / pInt) * pInt, 0, 0);
        crossedBoundary = currentBoundary.getTime() > lastBoundary.getTime();
      }

      const prevExpCrossed = this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : this.tariffHistory.current;
      const prevExpNotCrossed = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : this.tariffHistory.previous;
      const prevExp = crossedBoundary ? prevExpCrossed : prevExpNotCrossed;

      const tariffHistory = {
        previous: crossedBoundary ? this.tariffHistory.current : this.tariffHistory.previous,
        previousExport: prevExp,
        previousTm: crossedBoundary ? this.tariffHistory.currentTm : this.tariffHistory.previousTm,
        current: tariff,
        currentExport: exportT,
        currentTm,
      };
      this.tariffHistory = tariffHistory;
      const activeTariff = this.getActiveTariff({ meterValue: this.meterMoney?.meterValue || 0 }, tariff, exportT);
      await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));
      this.setSettings({ tariff }).catch((err) => this.error(err));
      await this.setStoreValue('tariffHistory', tariffHistory);
      await this.setStoreValue('priceInterval', this.priceInterval).catch((err) => this.error(err));

      if (args && args.currency && args.currency !== this.getSettings().currency) {
        this.log(`Auto-setting currency to ${args.currency} from DAP source`);
        await this.setSettings({ currency: args.currency }).catch((err) => this.error(err));
        this.currencyChanged = true;
        this.homey.setTimeout(() => this.restartDevice(2000).catch(this.error), 0);
      }
    } catch (error) {
      this.error(error);
    }
  }

  // Detect anomalous jumps in the incoming cumulative meter value, in two tiers:
  // - a GROSS jump (register corruption, unit mixup) is always rejected outright, regardless of
  //   this device's own scale.
  // - an ANOMALY jump - scaled to THIS device's own recent usage, see anomalyCeiling() - is
  //   *withheld* for one reading rather than trusted immediately. If the very next reading lands
  //   close to this same new level, it's a genuine step-change (source device/meter replacement,
  //   migration) and every period baseline is re-anchored to it - the same fix already proven
  //   for the battery driver (generic_bat_device.js:handleUpdateMeter()), generalized here for
  //   Power/Gas/Water/Solar/Grid. If instead the next reading falls back near the ORIGINAL
  //   value, the anomaly was a transient glitch (bad Zigbee frame, flaky API poll) and is
  //   discarded before it can become an hour/day/month/year delta or a new baseline.
  // This is what previously let a single bad reading either register as an "impossible"
  // consumption spike (magnitude under the old flat 10000 threshold, which a small appliance
  // could never plausibly reach in normal use either way) or poison a period baseline into a
  // permanent negative total (if it happened to land on a rollover) - see issues #126/#234/#341
  // and #155/#215/#289/#353.
  async checkMeterJump(value) {
    const GROSS_JUMP = 10000; // register corruption / unit mixup - always rejected, any device
    const IMPOSSIBLE_METER = 1e9; // kWh/m3 no household meter can ever legitimately reach

    const lastVal = this.getCapabilityValue(this.ds.cmap.meter_source);
    // Math.abs(), so a meter wired negative (solar/export) gets the same protection as a
    // normal one instead of being skipped entirely - see issue #353.
    if (lastVal === null || !Number.isFinite(lastVal) || !(Math.abs(lastVal) > 1)) {
      this.pendingAnomaly = null;
      return;
    }
    // The stored reading itself is corrupt (a source glitch that got through before this
    // check existed, or a bad value from a since-replaced device). Left in place it makes
    // every subsequent VALID reading look like a gross jump, so the device rejects real data
    // forever and never recovers - the user's only way out was re-pairing. Re-anchor to the
    // incoming value instead of rejecting against a number that can never be a meter.
    if (Math.abs(lastVal) > IMPOSSIBLE_METER) {
      this.pendingAnomaly = null;
      this.log(`${this.getName()}: stored meter value ${lastVal} is impossible. Re-anchoring baselines to ${value}.`);
      await this.reanchorBaselines(value);
      return;
    }
    const meterDelta = Math.abs(value - lastVal);
    if (meterDelta > GROSS_JUMP) throw Error(`ignoring unrealistic incoming meter value! ${value} (prev: ${lastVal})`);

    const anomalyJump = this.anomalyCeiling();
    if (meterDelta > anomalyJump) {
      const { pendingAnomaly } = this;
      if (pendingAnomaly && Math.abs(value - pendingAnomaly.value) <= anomalyJump) {
        // confirmed by a second, consistent reading: genuine step-change.
        this.pendingAnomaly = null;
        this.log(`${this.getName()}: meter jump confirmed (${meterDelta.toFixed(2)}). Re-anchoring baselines to ${value}.`);
        await this.reanchorBaselines(value);
        return;
      }
      this.pendingAnomaly = { value };
      throw Error(`holding anomalous meter value pending confirmation: ${value} (prev: ${lastVal})`);
    }

    this.pendingAnomaly = null;
  }

  // A single poll-to-poll delta should never itself approach, let alone dwarf, a full previous
  // period's worth of this device's own typical energy - a flat constant can't work across this
  // one shared class (a freezer's Aqara plug and a multi-kW EV charger both extend it), so the
  // ceiling is derived from what this specific device has actually been doing lately: 20x its
  // last known full hour, or 20x its last known full day (kept un-averaged, not /24, so devices
  // with legitimately bursty single-hour usage - e.g. EV charging concentrated overnight -
  // aren't falsely flagged). Falls back to a conservative fixed floor before any history exists
  // yet (freshly paired device, or right after a migration/repair).
  anomalyCeiling() {
    const RATIO = 20;
    const FLOOR = 1; // kWh, or m³ for gas/water
    const lastHour = this.getCapabilityValue(this.ds.cmap.last_hour);
    const lastDay = this.getCapabilityValue(this.ds.cmap.last_day);
    const reference = Math.max(
      typeof lastHour === 'number' ? Math.abs(lastHour) : 0,
      typeof lastDay === 'number' ? Math.abs(lastDay) : 0,
    );
    return Math.max(FLOOR, reference * RATIO);
  }

  // Re-anchors every period baseline (and the money accumulator's reference reading) to a
  // confirmed new meter value, so a genuine step-change never computes as a bogus multi-unit
  // delta, nor leaves a period total permanently negative for the rest of the day/month/year.
  async reanchorBaselines(meterValue) {
    const keys = ['lastReadingHour', 'lastReadingDay', 'lastReadingMonth', 'lastReadingYear'];
    await Promise.all(keys.map(async (key) => {
      if (this[key]) {
        this[key] = { ...this[key], meterValue };
        await this.setStoreValue(key, this[key]).catch((err) => this.error(err));
      }
    }));
    if (this.meterMoney) this.meterMoney.meterValue = meterValue;
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

      // filter unrealistic/anomalous meter values, and re-anchor baselines on a confirmed jump
      await this.checkMeterJump(value);

      const reading = await this.getReadingObject(value);
      // NOTE: gated on firstReadingDone, not initReady - initReady also gets forced true at the
      // end of onInit() for interval-polling devices (startPolling() fires its first poll without
      // awaiting it), which can race ahead of this check and permanently skip the one-time
      // lastMinMax migration below, crashing checkMinMax() on every poll forever. See git history.
      if (!this.firstReadingDone || !this.lastReadingYear) await this.initFirstReading(reading); // after app start
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
    let valHour = reading.meterValue - lastReadingHour.meterValue;
    let valDay = reading.meterValue - lastReadingDay.meterValue;
    let valMonth = reading.meterValue - lastReadingMonth.meterValue;
    let valYear = reading.meterValue - lastReadingYear.meterValue;

    // Safety net: self-heal a baseline that disagrees with the live meter by an IMPLAUSIBLE
    // margin (e.g. a stale baseline left over from before checkMeterJump()/onSettings()
    // validation existed) - re-anchor and persist it immediately, rather than leaving the
    // period stuck negative for its remainder. Deliberately does NOT fire on every negative
    // delta: a source that genuinely reports a signed/net-metered cumulative value (e.g. a
    // HomeWizard meter tracking net export as a decreasing/negative number) will produce small,
    // proportionate negative deltas on every tick, which are legitimate and must be left alone -
    // only a delta far outside this device's own normal scale is corruption, not real metering.
    // With no usage history yet (a brand-new device, still on its very first, already-validated
    // baseline) there's nothing to judge "implausible" against and no time for drift to have
    // occurred, so the check is skipped entirely rather than guessing with a generic floor.
    const lastHourRef = this.getCapabilityValue(this.ds.cmap.last_hour);
    const lastDayRef = this.getCapabilityValue(this.ds.cmap.last_day);
    const hasHistory = typeof lastHourRef === 'number' || typeof lastDayRef === 'number';
    const negativeCeiling = hasHistory ? this.anomalyCeiling() : Infinity;
    if (valHour < -negativeCeiling) {
      this.log(`${this.getName()}: implausible negative hour total (${valHour.toFixed(3)}) - re-anchoring baseline`);
      lastReadingHour = reading; valHour = 0;
      this.lastReadingHour = lastReadingHour;
      await this.setStoreValue('lastReadingHour', lastReadingHour).catch((err) => this.error(err));
    }
    if (valDay < -negativeCeiling) {
      this.log(`${this.getName()}: implausible negative day total (${valDay.toFixed(3)}) - re-anchoring baseline`);
      lastReadingDay = reading; valDay = 0;
      this.lastReadingDay = lastReadingDay;
      await this.setStoreValue('lastReadingDay', lastReadingDay).catch((err) => this.error(err));
    }
    if (valMonth < -negativeCeiling) {
      this.log(`${this.getName()}: implausible negative month total (${valMonth.toFixed(3)}) - re-anchoring baseline`);
      lastReadingMonth = reading; valMonth = 0;
      this.lastReadingMonth = lastReadingMonth;
      await this.setStoreValue('lastReadingMonth', lastReadingMonth).catch((err) => this.error(err));
    }
    if (valYear < -negativeCeiling) {
      this.log(`${this.getName()}: implausible negative year total (${valYear.toFixed(3)}) - re-anchoring baseline`);
      lastReadingYear = reading; valYear = 0;
      this.lastReadingYear = lastReadingYear;
      await this.setStoreValue('lastReadingYear', lastReadingYear).catch((err) => this.error(err));
    }

    if (periods.newHour) {
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
      await this.setCapability(this.ds.cmap.last_day, valDay).catch((err) => this.error(err));
      lastReadingDay = reading;
      await this.setStoreValue('lastReadingDay', reading);
      await this.setSettings({ meter_day_start: lastReadingDay.meterValue }).catch((err) => this.error(err));
      valDay = 0;
    }
    if (periods.newMonth) {
      await this.setCapability(this.ds.cmap.last_month, valMonth).catch((err) => this.error(err));
      lastReadingMonth = reading;
      await this.setStoreValue('lastReadingMonth', reading);
      await this.setSettings({ meter_month_start: lastReadingMonth.meterValue }).catch((err) => this.error(err));
      valMonth = 0;
    }
    if (periods.newYear) {
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
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
  }

  async updateTargets({ ...periods }) {
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
    let deltaMeter;
    if (this.meterMoney && typeof this.meterMoney.meterValue === 'number' && typeof reading.meterValue === 'number') {
      deltaMeter = reading.meterValue - this.meterMoney.meterValue;
    }
    return MeterHelpers.getActiveTariff(
      this.getSettings(),
      this.currentGridPower,
      tariff,
      exportTariff,
      deltaMeter,
    );
  }

  // Hook for a subclass to swap in a different settlement scheme for the SAME meter_money_*
  // totals below (e.g. pricing import/export deltas separately instead of netting the tick
  // first) - return a number to override the default sign-based deltaMoney, or null/undefined
  // to keep the default behavior. Base implementation is a no-op so every driver without an
  // override behaves exactly as before.
  async getMoneyDeltaOverride() {
    return null;
  }

  async updateMoney({ ...reading }, { ...periods }) {
    // Price-period boundary selection (does this reading cross into a new price interval, and
    // if so was the tariff only updated at/after that boundary, in which case fall back to the
    // PREVIOUS period's tariff to price the accumulated energy) - see MeterHelpers.getPeriodTariff().
    const priceInterval = this.priceInterval || 60;
    const lastReadingTm = this.lastMoneyReadingTm || new Date(new Date(reading.meterTm).getTime() - 1000);
    const { tariff, exportTariff } = MeterHelpers.getPeriodTariff(this.tariffHistory, priceInterval, reading.meterTm, lastReadingTm);

    this.lastMoneyReadingTm = reading.meterTm;

    // fall back to the import tariff if exportTariff is missing (undefined/null)
    const safeExportTariff = exportTariff !== undefined && exportTariff !== null ? exportTariff : tariff;

    const activeTariff = this.getActiveTariff(reading, tariff, safeExportTariff);

    if (activeTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));

    const deltaMoneyOverride = await this.getMoneyDeltaOverride(reading, periods);
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff, deltaMoneyOverride);

    let fixedMarkup = 0;
    if (periods.newHour) {
      meterMoney.lastHour = meterMoney.hour;
      meterMoney.hour = 0;
      fixedMarkup += (this.getSettings().markup_hour || 0);
      await this.setCapability('meter_money_last_hour', meterMoney.lastHour);
      await this.setSettings({ meter_money_last_hour: meterMoney.lastHour }).catch((err) => this.error(err));
    }
    if (periods.newDay) {
      meterMoney.lastDay = meterMoney.day;
      meterMoney.day = 0;
      fixedMarkup += (this.getSettings().markup_day || 0);
      await this.setCapability('meter_money_last_day', meterMoney.lastDay);
      await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch((err) => this.error(err));
    }
    if (periods.newMonth) {
      meterMoney.lastMonth = meterMoney.month;
      meterMoney.month = 0;
      fixedMarkup += (this.getSettings().markup_month || 0);
      await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
      await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch((err) => this.error(err));
    }
    if (periods.newYear) {
      meterMoney.lastYear = meterMoney.year;
      meterMoney.year = 0;
      await this.setCapability('meter_money_last_year', meterMoney.lastYear);
      await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch((err) => this.error(err));
    }
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;
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
    const moneyThisMonth = this.meterMoney.month;
    const meterThisMonth = this.getCapabilityValue(this.ds.cmap.this_month);
    if (meterThisMonth) await this.setCapability('meter_money_this_month_avg', moneyThisMonth / meterThisMonth).catch((err) => this.error(err));

    const moneyThisYear = this.meterMoney.year;
    const meterThisYear = this.getCapabilityValue(this.ds.cmap.this_year);
    if (meterThisYear) await this.setCapability('meter_money_this_year_avg', moneyThisYear / meterThisYear).catch((err) => this.error(err));
  }

  async updateMeasureMinMax({ ...reading }) {
    // minimal 2 minutes avg needed
    const deltaTm = new Date(reading.meterTm) - new Date(this.lastMinMax.reading.meterTm);
    const deltaMeter = reading.meterValue - this.lastMinMax.reading.meterValue;

    // Skip math-based trend if we have real-time power updates (prevents artificial spikes) -
    // measurePowerRealtime is the HOMEY-API device's secondary listener (see addListeners()),
    // measurePower is the METER_VIA_WATT (use_measure_source) device's primary listener; both
    // now feed checkMinMax() directly from the raw value as it arrives, so min/max is never
    // smoothed through the trend calc below just because the source is measure_power-only.
    if (this.capabilityInstances && (this.capabilityInstances.measurePowerRealtime || this.capabilityInstances.measurePower)) {
      this.lastMinMax.reading = reading;
      await this.setStoreValue('lastMinMax', this.lastMinMax);
      return;
    }

    if (deltaTm < 119000) return;
    const measureValue = this.calculateMeasureTrend(deltaMeter, deltaTm);
    await this.setCapability(this.ds.cmap.measure_source, measureValue).catch((err) => this.error(err));
    await this.checkMinMax(measureValue, reading);
  }

  calculateMeasureTrend(deltaMeter, deltaTm) {
    // Default to Power (kWh -> Watt)
    return Math.round((3600000000 / deltaTm) * deltaMeter);
  }

  // Tracks three independently-resetting min/max windows (day/month/year) instead of a single
  // manually-reset pair. NOTE: deliberately no "quarter" (15-min) period - a min/max of
  // instantaneous-ish readings WITHIN a 15-min window is a different metric than the AVERAGE
  // power over that whole window (total energy / 0.25h), which is what BE/NL capacity tariffs
  // actually bill on - tracking it here wouldn't serve that purpose and was removed.
  // Self-contained period-boundary detection from reading's own calendar fields (not a periods
  // object) because this is called from three places: the periodic/trend fallback below
  // (updateMeasureMinMax()) AND two realtime capability-listener paths (see addListeners())
  // that call it directly with no periods object available.
  // this.ds.cmap.minMaxPrefix selects the capability family per driver ('measure_watt' for
  // grid/solar/power, 'measure_lpm' for gas/water) - one generic implementation for all 5.
  async checkMinMax(val, reading) {
    const prefix = this.ds.cmap.minMaxPrefix || 'measure_watt';
    const { day, month, year } = this.lastMinMax;

    let changed = false;

    // Roll over (clear) each period whose boundary was just crossed. Guarded by "!== null" so
    // the very first-ever reading (all anchors still null from pair init) doesn't spuriously
    // "reset" an already-empty period.
    if (day.day !== null && (day.day !== reading.day || day.month !== reading.month)) {
      day.min = null; day.max = null; changed = true;
    }
    if (month.month !== null && (month.month !== reading.month || month.year !== reading.year)) {
      month.min = null; month.max = null; changed = true;
    }
    if (year.year !== null && year.year !== reading.year) {
      year.min = null; year.max = null; changed = true;
    }
    day.day = reading.day; day.month = reading.month;
    month.month = reading.month; month.year = reading.year;
    year.year = reading.year;

    [day, month, year].forEach((period) => {
      if (period.max === null || val > period.max) {
        period.max = val; changed = true;
      }
      if (period.min === null || val < period.min) {
        period.min = val; changed = true;
      }
    });

    if (this.lastMinMax.reading !== reading) {
      this.lastMinMax.reading = reading;
      changed = true;
    }

    if (changed) {
      if (this.minMaxInitReady) { // skip first interval after app start NEEDED BECAUSE OF POLLING NOT KNOWING CORRECT TIMESTAMP!!!
        await this.setCapability(`${prefix}_max.day`, day.max).catch((err) => this.error(err));
        await this.setCapability(`${prefix}_min.day`, day.min).catch((err) => this.error(err));
        await this.setCapability(`${prefix}_max.month`, month.max).catch((err) => this.error(err));
        await this.setCapability(`${prefix}_min.month`, month.min).catch((err) => this.error(err));
        await this.setCapability(`${prefix}_max.year`, year.max).catch((err) => this.error(err));
        await this.setCapability(`${prefix}_min.year`, year.min).catch((err) => this.error(err));
      } else {
        this.log('Skipping first min/max interval for', this.getName());
      }

      await this.setStoreValue('lastMinMax', this.lastMinMax).catch((err) => this.error('Failed to save lastMinMax:', err));
    }
    this.minMaxInitReady = true;
  }

}

module.exports = SumMeterDevice;
