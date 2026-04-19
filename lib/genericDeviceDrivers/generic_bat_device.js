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
const BatFlows = require('../flows/BatFlows');
const MeterHelpers = require('../MeterHelpers');
const DeviceMigrator = require('../DeviceMigrator');
const SourceDeviceHelper = require('../SourceDeviceHelper');
const { setTimeoutPromise } = require('../Util');

class BatDevice extends Device {

  // this method is called when the Device is inited
  async onInit() {
    try {
      // init some stuff
      this.restarting = false;
      this.initReady = false;
      this.flows = new BatFlows(this);

      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      this.timeZone = this.homey.clock.getTimezone();

      if (!this.migrated) await this.migrate();
      this.migrated = true;

      await DeviceMigrator.checkCurrencyMismatch(this, this.getSettings().currency, '€');

      if (this.currencyChanged) await DeviceMigrator.migrateCurrencyOptions(this, this.getSettings().currency, this.getSettings().decimals, '€');
      await this.setAvailable().catch((err) => this.error(err));

      // restore device values
      await this.initDeviceValues();

      // start listeners
      await this.addListeners();

      // poll first values
      await this.poll();

      this.initReady = true;

    } catch (error) {
      this.error(error);
      this.setUnavailable(error.message).catch((err) => this.error(err));
      this.initReady = false; // retry after 5 minutes
    }
  }

  async onUninit() {
    this.isDestroyed = true;
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    this.destroyListeners();
    let delay = 1500;
    if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
    await setTimeoutPromise(delay, this);
  }

  // migrate stuff from old version
  async migrate() {
    try {
      this.migrated = false;
      const correctCaps = [...this.driver.ds.deviceCapabilities];

      // check if roiEnable > add advanced ROI capabilities
      if (this.getSettings().roiEnable) {
        correctCaps.push('roi_duration');
      }

      const success = await DeviceMigrator.migrateCapabilities(this, correctCaps);
      if (!success) return Promise.resolve(false);

      // set new migrate level
      await this.setSettings({ level: this.homey.app.manifest.version }).catch((err) => this.error(err));
      return Promise.resolve(true);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
    }
  }

  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly, this);
    if (!this.isDestroyed) await this.onInit().catch((err) => this.error(err));
  }

  // this method is called when the Device is added
  async onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
  }

  // this method is called when the Device is deleted
  onDeleted() {
    this.destroyListeners();
    this.log(`Deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`${this.getName()} was renamed to: ${name}`);
  }

  // this method is called when the user has changed the device's settings in Homey.
  async onSettings({ newSettings, changedKeys }) {
    this.log(`${this.getName()} device settings changed by user`, newSettings);
    if (this.meterMoney) {
      const money = { ...this.meterMoney };
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
      }
    }
    if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
      this.currencyChanged = true;
    }
    if (changedKeys.includes('meter_kwh_charging')) await this.setCapability('meter_kwh_charging', newSettings.meter_kwh_charging);
    if (changedKeys.includes('meter_kwh_discharging')) await this.setCapability('meter_kwh_discharging', newSettings.meter_kwh_discharging);
    if (changedKeys.includes('tariff_update_group')) {
      this.driver.setPricesDevice(this, newSettings.tariff_update_group);
    }
    this.homey.setTimeout(() => {
      this.restartDevice(5000).catch((error) => this.error(error));
    }, 0);
    return Promise.resolve(true);
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

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      // only update changed capabilities
      if (value !== this.getCapabilityValue(capability)) {
        return this.setCapabilityValue(capability, value)
          .catch((error) => {
            this.error(error, capability, value);
          });
      }
    }
    return Promise.resolve();
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

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async getReadingObject(value) {
    const date = new Date();
    return MeterHelpers.getReadingObject(value, date, this.timeZone);
  }

  async initDeviceValues() {
    if (!this.available) this.setAvailable().catch((err) => this.error(err));
    this.log(`${this.getName()} Restoring device values after init`);

    // init pricesNextHours
    if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = await this.getStoreValue('pricesNextHoursMarketLength');
    if (!this.pricesNextHoursMarketLength) this.pricesNextHoursMarketLength = 99;
    if (!this.pricesNextHoursIsForecast) this.pricesNextHoursIsForecast = await this.getStoreValue('pricesNextHoursIsForecast');
    if (!this.pricesNextHours) this.pricesNextHours = await this.getStoreValue('pricesNextHours');
    if (!this.exportPricesNextHours) this.exportPricesNextHours = await this.getStoreValue('exportPricesNextHours');
    if (!this.exportPricesNextHours) this.exportPricesNextHours = this.pricesNextHours;
    if (!this.priceInterval) this.priceInterval = await this.getStoreValue('priceInterval') || 60;
    if (!this.pricesNextHours) {
      this.pricesNextHours = [0.25]; // set as default after pair
      // get DAP prices when available
      this.driver.setPricesDevice(this);
    }

    // init tariffHistory
    if (!this.tariffHistory) this.tariffHistory = await this.getStoreValue('tariffHistory');
    if (!this.tariffHistory) {
      this.tariffHistory = {
        previous: this.pricesNextHours ? this.pricesNextHours[0] : 0,
        previousExport: this.exportPricesNextHours ? this.exportPricesNextHours[0] : 0,
        previousTm: new Date(Date.now() - 3600000),
        current: this.pricesNextHours ? this.pricesNextHours[0] : 0,
        currentExport: this.exportPricesNextHours ? this.exportPricesNextHours[0] : 0,
        currentTm: new Date(),
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory).catch((err) => this.error(err));
    }

    // init incoming meter queue
    if (!this.newReadings) this.newReadings = [];

    // init this.soc
    const storedkWh = this.hasCapability('meter_kwh_stored') ? (this.getCapabilityValue('meter_kwh_stored') || 0) : 0;
    const capacity = this.getSettings().batCapacity || 50; // Prevent division by zero
    this.soc = (storedkWh / capacity) * 100;
    if (!this.soc) this.soc = 0;

    // init XOM
    this.xomTargetPower = 0;

    // init this.startDay, this.startMonth and this.year
    let startDateString = this.getSettings().start_date;
    if (!startDateString || startDateString.length !== 4) startDateString = '0101'; // ddmm
    this.startDay = Number(startDateString.slice(0, 2));
    this.startMonth = Number(startDateString.slice(2, 4));
    if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
    if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
    this.startMonth -= 1; // January is month 0

    // init this.lastReading
    if (!this.lastReadingHour) this.lastReadingHour = await this.getStoreValue('lastReadingHour');
    if (!this.lastReadingDay) this.lastReadingDay = await this.getStoreValue('lastReadingDay');
    if (!this.lastReadingMonth) this.lastReadingMonth = await this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = await this.getStoreValue('lastReadingYear');

    // PAIR init meter_power_hidden for use_measure_source
    const meterX = this.getCapabilityValue('meter_power_hidden');
    if (typeof meterX !== 'number') {
      this.log('meter kWh is set to 0 after device pair');
      await this.setCapability('meter_power_hidden', 0);
    }

    // init this.lastMeasure
    if (!this.lastMeasure) {
      this.lastMeasure = {
        value: 0,
        measureTm: new Date(),
      };
    }

    // init this.meterMoney
    if (!this.meterMoney) {
      this.meterMoney = {
        day: this.getCapabilityValue('meter_money_this_day'),
        month: this.getCapabilityValue('meter_money_this_month'),
        year: this.getCapabilityValue('meter_money_this_year'),
        meterValue: this.getCapabilityValue('meter_power_hidden'), // current meter value.
        lastDay: this.getCapabilityValue('meter_money_last_day'),
        lastMonth: this.getCapabilityValue('meter_money_last_month'),
        lastYear: this.getCapabilityValue('meter_money_last_year'),
      };
    }

    // update kWh readings in settings
    const meterCharging = this.hasCapability('meter_kwh_charging') ? this.getCapabilityValue('meter_kwh_charging') : null;
    const meterDischarging = this.hasCapability('meter_kwh_discharging') ? this.getCapabilityValue('meter_kwh_discharging') : null;
    if (meterCharging !== null) await this.setSettings({ meter_kwh_charging: meterCharging }).catch((err) => this.error(err));
    if (meterDischarging !== null) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch((err) => this.error(err));
  }

  // init some stuff when first reading comes in
  async initFirstReading({ ...reading }) {
    // check pair init
    const pairInit = (!this.lastReadingHour || !this.lastReadingDay || !this.lastReadingMonth || !this.lastReadingYear);
    if (pairInit) {
      this.log(`${this.getName()} Setting values after pair init`);
      await this.setStoreValue('lastReadingHour', reading);
      this.lastReadingHour = reading;
      const dayStart = this.getSettings().homey_device_daily_reset ? await this.getReadingObject(0) : reading;
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
    this.initReady = true;
  }

  // update the prices from DAP
  async updatePrices(pricesNextHours, exportPricesNextHours, pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast, currency) {
    try {
      if (!pricesNextHours || !pricesNextHours[0]) {
        this.pricesNextHours = null;
        this.exportPricesNextHours = null;
        this.pricesNextHoursMarketLength = 0;
        this.pricesNextHoursIsForecast = null;
        await this.setStoreValue('pricesNextHours', null).catch((err) => this.error(err));
        await this.setStoreValue('exportPricesNextHours', null).catch((err) => this.error(err));
        await this.setStoreValue('pricesNextHoursMarketLength', 0).catch((err) => this.error(err));
        await this.setStoreValue('pricesNextHoursIsForecast', null).catch((err) => this.error(err));
        return;
      }
      this.pricesNextHoursMarketLength = pricesNextHoursMarketLength;
      this.pricesNextHoursIsForecast = pricesNextHoursIsForecast;

      if (currency && this.getSettings().currency === '') {
        this.log(`Auto-setting currency to ${currency} from DAP source`);
        await this.setSettings({ currency }).catch((err) => this.error(err));
        this.currencyChanged = true;
        this.homey.setTimeout(() => this.restartDevice(2000).catch(this.error), 0);
      }

      const pricesChanged = JSON.stringify(pricesNextHours) !== JSON.stringify(this.pricesNextHours) || JSON.stringify(exportPricesNextHours) !== JSON.stringify(this.exportPricesNextHours);
      const intervalChanged = this.priceInterval !== priceInterval;
      if (this.initReady && !pricesChanged && !intervalChanged) return; // only update when changed

      this.pricesNextHours = pricesNextHours;
      this.exportPricesNextHours = exportPricesNextHours;
      this.priceInterval = priceInterval;

      let activeTariff = pricesNextHours[0];
      const tariffType = this.getSettings().tariff_type || 'dynamic';
      if (tariffType === 'export') activeTariff = exportPricesNextHours[0];
      else if (tariffType === 'dynamic' && typeof this.currentGridPower === 'number' && this.currentGridPower <= 0) activeTariff = exportPricesNextHours[0];

      // Check if we crossed a 15/60 min period boundary to safely shift history
      let crossedBoundary = true;
      if (this.tariffHistory && this.tariffHistory.currentTm) {
        const lastTm = new Date(this.tariffHistory.currentTm);
        const pInt = priceInterval || 60;
        const lastBoundary = new Date(lastTm);
        lastBoundary.setUTCMinutes(Math.floor(lastTm.getUTCMinutes() / pInt) * pInt, 0, 0);
        const currentBoundary = new Date();
        currentBoundary.setUTCMinutes(Math.floor(currentBoundary.getUTCMinutes() / pInt) * pInt, 0, 0);
        crossedBoundary = currentBoundary.getTime() > lastBoundary.getTime();
      }

      let prevPrice = pricesNextHours[0];
      let prevExportPrice = exportPricesNextHours[0];
      let prevTime = new Date(Date.now() - 3600000);
      if (this.tariffHistory) {
        prevPrice = crossedBoundary ? this.tariffHistory.current : this.tariffHistory.previous;
        prevExportPrice = crossedBoundary ? this.tariffHistory.currentExport : this.tariffHistory.previousExport;
        prevTime = crossedBoundary ? this.tariffHistory.currentTm : this.tariffHistory.previousTm;
      }

      // Track history to ensure correct billing calculation at hour boundaries
      this.tariffHistory = {
        previous: prevPrice,
        previousExport: prevExportPrice,
        previousTm: prevTime,
        current: pricesNextHours[0],
        currentExport: exportPricesNextHours[0],
        currentTm: new Date(),
      };
      await this.setStoreValue('tariffHistory', this.tariffHistory).catch((err) => this.error(err));

      await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHours', pricesNextHours).catch((err) => this.error(err));
      await this.setStoreValue('exportPricesNextHours', exportPricesNextHours).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHoursMarketLength', pricesNextHoursMarketLength).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHoursIsForecast', pricesNextHoursIsForecast).catch((err) => this.error(err));
      await this.setStoreValue('priceInterval', priceInterval).catch((err) => this.error(err));
      if (this.initReady && this.onPricesUpdated) {
        await this.onPricesUpdated();
      }
    } catch (error) {
      this.error(error);
    }
  }

  async handleUpdateMeter(reading) {
    try {
      // Protect against massive jumps in meter value (e.g. during migration or device replacement)
      const lastMeterValue = this.getCapabilityValue('meter_power_hidden');
      if (typeof lastMeterValue === 'number') {
        const meterDelta = Math.abs(reading.meterValue - lastMeterValue);
        if (meterDelta > 50) { // 50 kWh jump between two readings is an anomaly
          this.log(`Large meter jump detected (${meterDelta.toFixed(2)} kWh). Resetting baselines to prevent money spikes.`);
          if (this.lastReadingHour) {
            this.lastReadingHour.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingHour', this.lastReadingHour).catch(this.error);
          }
          if (this.lastReadingDay) {
            this.lastReadingDay.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingDay', this.lastReadingDay).catch(this.error);
          }
          if (this.lastReadingMonth) {
            this.lastReadingMonth.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingMonth', this.lastReadingMonth).catch(this.error);
          }
          if (this.lastReadingYear) {
            this.lastReadingYear.meterValue = reading.meterValue;
            await this.setStoreValue('lastReadingYear', this.lastReadingYear).catch(this.error);
          }
          if (this.meterMoney) this.meterMoney.meterValue = reading.meterValue;
        }
      }

      const periods = MeterHelpers.getPeriods(
        reading,
        this.lastReadingHour,
        this.lastReadingDay,
        this.lastReadingMonth,
        this.lastReadingYear,
        this.startDay,
        this.startMonth,
      );
      await this.updateMeters(reading, periods);
      await this.updateMoney(reading, periods);
    } catch (error) {
      this.error(error);
    }
  }

  async updateValue(val, cap) {
    try {
      if (cap === 'chargeMode') return;
      if (cap === 'soc') {
        this.soc = val;
        const storedkWh = val * (this.getSettings().batCapacity / 100);
        await this.setCapability('meter_kwh_stored', storedkWh).catch((err) => this.error(err));
      }
      if (cap === 'productionPower') {
        await this.updateMeterFromMeasure(val).catch((err) => this.error(err));
      }
      if (cap === 'usagePower') {
        await this.updateMeterFromMeasure(-val).catch(this.error);
      }
      if (cap === 'newMeasurePower') {
        this.lastNewMeasurePower = val;
        await this.processNewMeasurePower();
      }
      if (cap === 'chargingState') {
        this.lastChargingState = val;
        await this.processNewMeasurePower();
      }
      if (cap === 'meterCharging') {
        this.lastMeterCharging = val;
        if (this.hasCapability('meter_kwh_charging')) await this.setCapability('meter_kwh_charging', val).catch((err) => this.error(err));
        await this.processSourceMeters();
      }
      if (cap === 'meterDischarging') {
        this.lastMeterDischarging = val;
        if (this.hasCapability('meter_kwh_discharging')) await this.setCapability('meter_kwh_discharging', val).catch((err) => this.error(err));
        await this.processSourceMeters();
      }
    } catch (error) {
      this.error(error);
    }
  }

  async processNewMeasurePower() {
    let val = this.lastNewMeasurePower;
    if (typeof val !== 'number') return;

    if (this.lastChargingState) {
      val = Math.abs(val);
      if (this.lastChargingState === 'discharging') {
        val = -val;
      } else if (this.lastChargingState === 'idle') {
        val = 0;
      }
    }

    await this.updateMeterFromMeasure(val).catch((err) => this.error(err));
  }

  async processSourceMeters() {
    const charging = typeof this.lastMeterCharging === 'number' ? this.lastMeterCharging : this.getCapabilityValue('meter_kwh_charging') || 0;
    const discharging = typeof this.lastMeterDischarging === 'number' ? this.lastMeterDischarging : this.getCapabilityValue('meter_kwh_discharging') || 0;

    const netMeter = discharging - charging;
    await this.updateMeter(netMeter);
  }

  async updateMeter(val) {
    try {
      if (typeof val !== 'number') return;
      if (!this.migrated || this.currencyChanged) return;

      const reading = await this.getReadingObject(val);
      if (!this.initReady || !this.lastReadingYear) await this.initFirstReading(reading);

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

  // takes Watt, creates kWh metervalue
  async updateMeterFromMeasure(val) {
    if (!this.migrated) return;
    const measureTm = new Date();
    let value = val;
    // apply power corrections if needed (currently commented out in original)
    // standby
    if (val === 0) value += (this.getSettings().ownPowerStandby || 0);

    if (typeof value !== 'number') return;
    const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);

    const lastMeterValue = this.getCapabilityValue('meter_power_hidden');
    let lastChargingMeterValue = this.getCapabilityValue('meter_kwh_charging');
    let lastDischargingMeterValue = this.getCapabilityValue('meter_kwh_discharging');

    if (typeof lastMeterValue !== 'number') {
      this.error('lastMeterValue is NaN, WTF');
      return;
    }
    if (typeof deltaTm !== 'number' || deltaTm === 0) {
      this.error('deltaTm is NaN, WTF');
      return;
    }

    const deltaMeter = (this.lastMeasure.value * deltaTm) / 3600000000;
    const meter = lastMeterValue - deltaMeter;

    const hasSourceMeters = this.sourceCapGroup && (this.sourceCapGroup.meterCharging || this.sourceCapGroup.meterDischarging);

    if (!hasSourceMeters) {
      if (deltaMeter < 0) {
        if (this.hasCapability('meter_kwh_discharging')) {
          lastDischargingMeterValue = (lastDischargingMeterValue || 0) - deltaMeter;
          await this.setCapability('meter_kwh_discharging', lastDischargingMeterValue).catch((err) => this.error(err));
        }
      } else if (this.hasCapability('meter_kwh_charging')) {
        lastChargingMeterValue = (lastChargingMeterValue || 0) + deltaMeter;
        await this.setCapability('meter_kwh_charging', lastChargingMeterValue).catch((err) => this.error(err));
      }
      await this.updateMeter(meter);
    }

    await this.setCapability('measure_watt_avg', value).catch((err) => this.error(err));
    this.lastMeasure = {
      value,
      measureTm,
    };
  }

  async updateMeters({ ...reading }, { ...periods }) {
    await this.setCapability('meter_power_hidden', reading.meterValue).catch((err) => this.error(err));
    // temp copy this.lastReadingX
    let lastReadingHour = { ...this.lastReadingHour };
    let lastReadingDay = { ...this.lastReadingDay };
    let lastReadingMonth = { ...this.lastReadingMonth };
    let lastReadingYear = { ...this.lastReadingYear };
    // set capabilities
    if (periods.newHour) {
      lastReadingHour = reading;
      await this.setStoreValue('lastReadingHour', reading);
      await this.setSettings({ meter_latest: `${reading.meterValue}` }).catch((err) => this.error(err));

      const meterCharging = this.hasCapability('meter_kwh_charging') ? this.getCapabilityValue('meter_kwh_charging') : null;
      const meterDischarging = this.hasCapability('meter_kwh_discharging') ? this.getCapabilityValue('meter_kwh_discharging') : null;
      if (meterCharging !== null) await this.setSettings({ meter_kwh_charging: meterCharging }).catch((err) => this.error(err));
      if (meterDischarging !== null) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch((err) => this.error(err));
    }
    if (periods.newDay) {
      lastReadingDay = reading;
      await this.setStoreValue('lastReadingDay', reading);
    }
    if (periods.newMonth) {
      lastReadingMonth = reading;
      await this.setStoreValue('lastReadingMonth', reading);
    }
    if (periods.newYear) {
      lastReadingYear = reading;
      await this.setStoreValue('lastReadingYear', reading);
    }
    // store this.lastReadingX
    if (periods.newHour) this.lastReadingHour = lastReadingHour;
    if (periods.newDay) this.lastReadingDay = lastReadingDay;
    if (periods.newMonth) this.lastReadingMonth = lastReadingMonth;
    if (periods.newYear) this.lastReadingYear = lastReadingYear;
  }

  async updateMoney({ ...reading }, { ...periods }) {
    const purchaseTariff = (this.pricesNextHours && this.pricesNextHours[0] !== undefined) ? this.pricesNextHours[0] : (this.getCapabilityValue('meter_tariff') || 0);
    const exportTariff = (this.exportPricesNextHours && this.exportPricesNextHours[0] !== undefined) ? this.exportPricesNextHours[0] : purchaseTariff;

    let tariff = purchaseTariff;
    let expTariff = exportTariff;

    // Calculate price period boundaries
    const priceInterval = this.priceInterval || 60;
    const readingDate = new Date(reading.meterTm);
    const startOfReadingPeriod = new Date(readingDate);
    startOfReadingPeriod.setUTCMinutes(Math.floor(readingDate.getUTCMinutes() / priceInterval) * priceInterval, 0, 0);

    const lastReadingDate = this.lastMoneyReadingTm ? new Date(this.lastMoneyReadingTm) : new Date(readingDate.getTime() - 1000);
    const startOfLastPeriod = new Date(lastReadingDate);
    startOfLastPeriod.setUTCMinutes(Math.floor(lastReadingDate.getUTCMinutes() / priceInterval) * priceInterval, 0, 0);

    const newPricePeriod = startOfReadingPeriod.getTime() > startOfLastPeriod.getTime();

    // If this reading marks a new period, we need the tariff of the PREVIOUS period to calculate the cost of the accumulated energy.
    if (newPricePeriod && this.tariffHistory && this.tariffHistory.currentTm) {
      const currentTariffDate = new Date(this.tariffHistory.currentTm);

      // If current tariff was updated AT OR AFTER the start of the reading's period, we must fallback to the previous tariff.
      if (currentTariffDate.getTime() >= startOfReadingPeriod.getTime()) {
        tariff = this.tariffHistory.previous;
        expTariff = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : tariff;
      }
    }

    this.lastMoneyReadingTm = reading.meterTm;

    const tariffType = this.getSettings().tariff_type || 'dynamic';

    let activeTariff = tariff;
    if (tariffType === 'import') {
      activeTariff = tariff;
    } else if (tariffType === 'export') {
      activeTariff = expTariff;
    } else if (typeof this.currentGridPower === 'number') {
      activeTariff = this.currentGridPower > 0 ? tariff : expTariff;
    }
    // Fallback if grid power is unknown: default to purchaseTariff.
    // The value of discharging is avoiding a purchase, and the cost of charging is the purchase price.

    if (activeTariff !== this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', activeTariff).catch((err) => this.error(err));

    // Calculate new money state using helper
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, activeTariff);

    if (periods.newDay) {
      meterMoney.lastDay = meterMoney.day;
      meterMoney.day = 0;
      await this.setCapability('meter_money_last_day', meterMoney.lastDay);
      await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch((err) => this.error(err));
    }
    if (periods.newMonth) {
      meterMoney.lastMonth = meterMoney.month;
      meterMoney.month = 0;
      await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
      await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch((err) => this.error(err));
    }
    if (periods.newYear) {
      meterMoney.lastYear = meterMoney.year;
      meterMoney.year = 0;
      await this.setCapability('meter_money_last_year', meterMoney.lastYear);
      await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch((err) => this.error(err));
    }

    // update money_this_x capabilities
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

}

module.exports = BatDevice;
