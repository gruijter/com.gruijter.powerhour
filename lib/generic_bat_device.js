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
const util = require('util');
const crypto = require('crypto');
const charts = require('./Charts');
const BatFlows = require('./BatFlows');
const { imageUrlToStream } = require('./ImageHelpers');
const MeterHelpers = require('./MeterHelpers');

const setTimeoutPromise = util.promisify(setTimeout);

class BatDevice extends Device {

  // this method is called when the Device is inited
  async onInitDevice() {
    try {
      // init some stuff
      this.restarting = false;
      this.initReady = false;
      this.flows = new BatFlows(this);

      this.destroyListeners();
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.timeZone = this.homey.clock.getTimezone();

      if (!this.migrated) await this.migrate();
      this.migrated = true;

      if (this.currencyChanged) await this.migrateCurrencyOptions(this.getSettings().currency, this.getSettings().decimals);
      await this.setAvailable().catch((err) => this.error(err));

      // restore device values
      await this.initDeviceValues();

      // start listeners
      await this.addListeners();

      // poll first values
      await this.poll();

      this.initReady = true;

      // create Strategy and ROI chart
      if (this.getSettings().roiEnable) {
        await setTimeoutPromise(10000 + (Math.random() * 10000)).catch((err) => this.error(err));
        if (this.sessionId !== currentSessionId) return;
        await this.flows.triggerNewRoiStrategyFlow().catch((err) => this.error(err));
        if (this.sessionId !== currentSessionId) return;
        await this.updateChargeChart().catch((err) => this.error(err));
      }
    } catch (error) {
      this.error(error);
      this.setUnavailable(error.message).catch((err) => this.error(err));
      this.initReady = false; // retry after 5 minutes
    }
  }

  async onUninit() {
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    this.destroyListeners();
    let delay = 1500;
    if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
    await setTimeoutPromise(delay);
  }

  // migrate stuff from old version
  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      this.migrated = false;

      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = { ...this[sym] };
      // check and repair incorrect capability(order)
      const correctCaps = this.driver.ds.deviceCapabilities;

      // check if roiEnable > add advanced ROI capabilities
      if (this.getSettings().roiEnable) {
        correctCaps.push('roi_duration');
      }

      for (let index = 0; index < correctCaps.length; index += 1) {
        const caps = this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          this.setUnavailable(this.homey.__('device_migrating')).catch((err) => this.error(err));
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i]).catch((err) => this.error(err));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          this.log(`adding capability ${newCap} for ${this.getName()}`);
          await this.addCapability(newCap).catch((err) => this.error(err));
          // restore capability state
          if (state[newCap] !== undefined) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
          else this.log(`${this.getName()} no value to restore for new capability ${newCap}, ${state[newCap]}!`);
          await this.setCapability(newCap, state[newCap]);
          await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
        }
      }

      // set new migrate level
      await this.setSettings({ level: this.homey.app.manifest.version }).catch((err) => this.error(err));
      Promise.resolve(true);
    } catch (error) {
      this.error('Migration failed', error);
      Promise.reject(error);
    }
  }

  async migrateCurrencyOptions(currency, decimals) {
    this.log('migrating capability options');
    this.setUnavailable(this.homey.__('device_migrating')).catch((err) => this.error(err));
    const options = {
      units: { en: currency },
      decimals,
    };
    if (!currency || currency === '') options.units.en = '€';
    if (!Number.isInteger(decimals)) options.decimals = 4;
    const moneyCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_money') || name.includes('meter_tariff'));
    for (let i = 0; i < moneyCaps.length; i += 1) {
      this.log(`migrating ${moneyCaps[i]} to use ${options.units.en} and ${options.decimals} decimals`);
      await this.setCapabilityOptions(moneyCaps[i], options).catch((err) => this.error(err));
      await setTimeoutPromise(2 * 1000);
    }
    this.currencyChanged = false;
  }

  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly);
    await this.onInitDevice().catch((err) => this.error(err));
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
    if (!this.migrated) throw Error(this.homey.__('error_device_not_ready'));
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
    setTimeout(() => {
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
      this.setCapabilityValue(capability, value)
        .catch((error) => {
          this.error(error, capability, value);
        });
    }
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
    if (!this.priceInterval) this.priceInterval = await this.getStoreValue('priceInterval') || 60;
    if (!this.pricesNextHours) {
      this.pricesNextHours = [0.25]; // set as default after pair
      // get DAP prices when available
      this.driver.setPricesDevice(this);
    }

    // init incoming meter queue
    if (!this.newReadings) this.newReadings = [];

    // init this.soc
    const storedkWh = await this.getCapabilityValue('meter_kwh_stored');
    this.soc = (storedkWh / this.getSettings().batCapacity) * 100;
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
    const meterX = await this.getCapabilityValue('meter_power_hidden');
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
        day: await this.getCapabilityValue('meter_money_this_day'),
        month: await this.getCapabilityValue('meter_money_this_month'),
        year: await this.getCapabilityValue('meter_money_this_year'),
        meterValue: await this.getCapabilityValue('meter_power_hidden'), // current meter value.
        lastDay: await this.getCapabilityValue('meter_money_last_day'),
        lastMonth: await this.getCapabilityValue('meter_money_last_month'),
        lastYear: await this.getCapabilityValue('meter_money_last_year'),
      };
    }

    // update kWh readings in settings
    const meterCharging = await this.getCapabilityValue('meter_kwh_charging');
    const meterDischarging = await this.getCapabilityValue('meter_kwh_discharging');
    if (meterCharging) await this.setSettings({ meter_kwh_charging: meterCharging }).catch((err) => this.error(err));
    if (meterDischarging) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch((err) => this.error(err));
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
  async updatePrices(pricesNextHours, pricesNextHoursMarketLength, priceInterval, pricesNextHoursIsForecast) {
    try {
      if (!pricesNextHours || !pricesNextHours[0]) {
        this.pricesNextHours = null;
        this.pricesNextHoursMarketLength = 0;
        this.pricesNextHoursIsForecast = null;
        await this.setStoreValue('pricesNextHours', null).catch((err) => this.error(err));
        await this.setStoreValue('pricesNextHoursMarketLength', 0).catch((err) => this.error(err));
        await this.setStoreValue('pricesNextHoursIsForecast', null).catch((err) => this.error(err));
        return;
      }
      this.pricesNextHoursMarketLength = pricesNextHoursMarketLength;
      this.pricesNextHoursIsForecast = pricesNextHoursIsForecast;

      const pricesChanged = JSON.stringify(pricesNextHours) !== JSON.stringify(this.pricesNextHours);
      const intervalChanged = this.priceInterval !== priceInterval;
      if (this.initReady && !pricesChanged && !intervalChanged) return; // only update when changed

      this.pricesNextHours = pricesNextHours;
      this.priceInterval = priceInterval;
      await this.setCapability('meter_tariff', pricesNextHours[0]).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHours', pricesNextHours).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHoursMarketLength', pricesNextHoursMarketLength).catch((err) => this.error(err));
      await this.setStoreValue('pricesNextHoursIsForecast', pricesNextHoursIsForecast).catch((err) => this.error(err));
      await this.setStoreValue('priceInterval', priceInterval).catch((err) => this.error(err));
      // trigger ROI card
      if (this.initReady && this.getSettings().roiEnable) {
        await this.flows.triggerNewRoiStrategyFlow();
        await this.updateChargeChart();
      }
    } catch (error) {
      this.error(error);
    }
  }

  // trigger XOM flow cards SEE BAT DRIVER

  async updateChargeChart() {
    if (!this.pricesNextHours) throw Error('No prices available');
    this.log('updating charge chart', this.getName());
    const minPriceDelta = this.getSettings().roiMinProfit;
    const strategy = await this.flows.find_roi_strategy({ minPriceDelta }).catch((err) => this.error(err));
    if (strategy) {
      await this.setCapability('roi_duration', strategy.duration).catch((err) => this.error(err));
      if (this.pricesNextHoursIsForecast) {
        const scheme = JSON.parse(strategy.scheme);
        Object.keys(scheme).forEach((k) => {
          if (this.pricesNextHoursIsForecast[k]) scheme[k].isForecast = true;
        });
        strategy.scheme = JSON.stringify(scheme);
      }
      const now = new Date();
      now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
      const H0 = nowLocal.getHours();
      const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;
      const startHour = H0 + (M0 / 60);
      // eslint-disable-next-line max-len
      const urlNextHours = await charts.getChargeChart(strategy, startHour, this.pricesNextHoursMarketLength, this.getSettings().chargePower, this.getSettings().dischargePower, this.priceInterval);
      if (!this.nextHoursChargeImage) {
        this.nextHoursChargeImage = await this.homey.images.createImage();
        await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
      }
      this.nextHoursChargeImage.setStream(async (stream) => {
        return imageUrlToStream(urlNextHours, stream);
      });
      await this.nextHoursChargeImage.update().catch((err) => this.error(err));
    }
    return Promise.resolve(true);
  }

  async handleUpdateMeter(reading) {
    try {
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
    } catch (error) {
      this.error(error);
    }
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
    if (val === 0) value -= this.getSettings().ownPowerStandby;

    if (typeof value !== 'number') return;
    const deltaTm = measureTm - new Date(this.lastMeasure.measureTm);

    const lastMeterValue = await this.getCapabilityValue('meter_power_hidden');
    let lastChargingMeterValue = await this.getCapabilityValue('meter_kwh_charging');
    let lastDischargingMeterValue = await this.getCapabilityValue('meter_kwh_discharging');

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

    if (deltaMeter < 0) {
      lastDischargingMeterValue -= deltaMeter;
      await this.setCapability('meter_kwh_discharging', lastDischargingMeterValue).catch((err) => this.error(err));
    } else {
      lastChargingMeterValue += deltaMeter;
      await this.setCapability('meter_kwh_charging', lastChargingMeterValue).catch((err) => this.error(err));
    }

    await this.setCapability('measure_watt_avg', value).catch((err) => this.error(err));
    this.lastMeasure = {
      value,
      measureTm,
    };
    await this.updateMeter(meter);
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

      const meterCharging = await this.getCapabilityValue('meter_kwh_charging');
      const meterDischarging = await this.getCapabilityValue('meter_kwh_discharging');
      if (meterCharging) await this.setSettings({ meter_kwh_charging: meterCharging }).catch((err) => this.error(err));
      if (meterDischarging) await this.setSettings({ meter_kwh_discharging: meterDischarging }).catch((err) => this.error(err));
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
    const tariff = (this.pricesNextHours && this.pricesNextHours[0] !== undefined) ? this.pricesNextHours[0] : (await this.getCapabilityValue('meter_tariff') || 0);

    if (tariff !== await this.getCapabilityValue('meter_tariff')) await this.setCapability('meter_tariff', tariff).catch((err) => this.error(err));

    // Calculate new money state using helper
    const meterMoney = MeterHelpers.calculateMoney(this.meterMoney, reading, tariff);

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

  triggerXOMFlow(strat, samples, x, smoothing, minLoad) {
    return this.flows.triggerXomFlow(strat, samples, x, smoothing, minLoad);
  }

}

module.exports = BatDevice;
