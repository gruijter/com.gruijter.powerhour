/* eslint-disable no-await-in-loop */
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

const Homey = require('homey');
const util = require('util');
const ECB = require('../ecb_exchange_rates');
const FORECAST = require('../stekker');
const charts = require('../charts');

const setTimeoutPromise = util.promisify(setTimeout);

// calculate the average price of an array of prices
const average = (array) => array.reduce((partialAvg, value) => partialAvg + value / array.length, 0);

// map to array of only prices within chosen period
const selectPrices = ([...prices], start, end) => prices
  .filter((hourInfo) => new Date(hourInfo.time) >= start)
  .filter((hourInfo) => new Date(hourInfo.time) < end)
  .map((hourInfo) => hourInfo.muPrice);

// map Time Of Day string to object 0-24
const todMap = (val) => {
  const v = val.replace(/\s/g, '');
  if (v === '' || v === '0' || v === '0:0') return null;
  const hours = v
    .split(';')
    .filter((hm) => hm !== '')
    .sort((a, b) => a.split(':')[0] - b.split(':')[0])
    .map((hour) => {
      const hm = hour.split(':');
      let valid = hm.length === 2;
      if (valid) {
        const h = Number(hm[0]);
        const m = Number(hm[1]);
        valid = valid && Number.isInteger(h) && h >= 0 && h < 24 && Number.isFinite(m);
        if (valid) return [`${h.toString()}`, m];
      }
      return null;
    });
  if (hours.includes(null)) throw Error('Invalid string for TOD');
  const todObject = {};
  let lastValue = hours.slice(-1)[0][1];
  for (let i = 0; i < 24; i += 1) {
    const hm = hours.find((x) => Number(x[0]) === i);
    const value = hm ? hm[1] : lastValue;
    todObject[i] = Number(value);
    lastValue = value;
  }
  return todObject;
};

class MyDevice extends Homey.Device {

  // INIT STUFF
  async onInitDevice() {
    try {
      await this.destroyListeners();
      this.restarting = false;
      this.initReady = false;
      this.settings = await this.getSettings();
      this.timeZone = this.homey.clock.getTimezone();
      this.fetchDelay = (Math.random() * 4 * 60 * 1000) + (1000 * 60 * 1.5);
      if (!this.prices) this.prices = this.getStoreValue('prices'); // restore from persistent memory on app restart
      if (!this.prices) this.prices = [{ time: null, price: null, muPrice: null }];
      if (!this.marketPrices) this.marketPrices = [];

      // check migrations
      if (!this.migrated) await this.migrate();
      if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);

      // calculate todMarkups
      this.todMarkups = todMap(this.settings.fixedMarkupTOD);

      // setup exchange rate api
      this.exchange = new ECB();

      // setup pricing providers
      this.dap = [];
      const providers = this.driver.ds.providers.filter((Provider) => { // select providers that support this bidding zone
        const dap = new Provider();
        const zones = dap.getBiddingZones();
        const hasZone = Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
        return hasZone;
      });
      const apiKey = Homey.env ? Homey.env.ENTSOE_API_KEY : '';
      providers.forEach((Provider, index) => {
        this.dap[index] = new Provider({ apiKey, biddingZone: this.settings.biddingZone });
      });
      if (!this.dap[0]) {
        this.error(this.getName(), 'no provider found for bidding zone', this.settings.biddingZone);
        return;
      }
      // console.log(this.getName(), this.dap[0]);

      // add forecast pricing provider
      if (this.driver.ds.driverId === 'dap' && this.settings.forecastEnable) {
        const forecast = new FORECAST();
        const zones = forecast.getBiddingZones();
        const hasZone = Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
        if (hasZone) this.dapForecast = new FORECAST({ biddingZone: this.settings.biddingZone });
      }

      // fetch and handle prices now, after short random delay
      await this.setAvailable().catch(this.error);
      await setTimeoutPromise(this.fetchDelay / 30, 'waiting is done'); // spread over 1 minute for API rate limit (400 / min)
      await this.fetchExchangeRate();
      await this.fetchPrices();
      // await this.setCapabilitiesAndFlows();

      // start fetching and handling prices on every hour
      this.eventListenerHour = async () => {
        this.log('new hour event received');
        await this.fetchExchangeRate();
        await this.setCapabilitiesAndFlows();
        await setTimeoutPromise(this.fetchDelay, 'waiting is done'); // spread over 30 minutes for API rate limit (400 / min)
        await this.fetchPrices();
      };
      this.homey.on('everyhour', this.eventListenerHour);

      this.initReady = true;
      this.log(`${this.getName()} finished initialization`);
    } catch (error) {
      this.error(error);
      // this.setUnavailable(error.message).catch(this.error).catch(this.error);
      await this.restartDevice(1 * 60 * 1000).catch(this.error); // restart after 1 minute
    }
  }

  async onUninit() {
    this.log(`Homey is killing ${this.getName()}`);
    await this.destroyListeners().catch(this.error);
    let delay = 1500;
    if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
    await setTimeoutPromise(delay);
  }

  async destroyListeners() {
    if (this.eventListenerHour) await this.homey.removeListener('everyhour', this.eventListenerHour);
  }

  // MIGRATE STUFF from old version < 5.0.0
  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      // console.log(this.getName(), this.settings, this.getStore());

      // migration from < v5.0
      if (this.driver.ds.driverId === 'dap' && (this.settings.biddingZone === 'TTF_EOD' || this.settings.biddingZone === 'TTF_LEBA')) {
        const excerpt = `The PBTH app migrated to version ${this.homey.app.manifest.version} **REMOVE AND RE-ADD YOUR GAS DAP DEVICE!**`;
        await this.homey.notifications.createNotification({ excerpt });
        this.setUnavailable('DEPRECATED. PLEASE REMOVE AND RE-ADD THIS DEVICE').catch(this.error);
        this.log(this.getName(), 'is disabled (using a deprecated driver)');
        return;
      }

      // migration from < v5.1.5
      if (this.driver.ds.driverId === 'dapg' && (this.settings.biddingZone.includes('/17'))) {
        if (this.settings.biddingZone === '132733/137/17') await this.setSettings({ biddingZone: 'TTF_EOD' }).catch(this.error);
        if (this.settings.biddingZone === '132735/139/17') await this.setSettings({ biddingZone: 'TTF_EGSI' }).catch(this.error);
        this.log(this.getName(), 'biddingZone migrated to', this.getSettings().biddingZone);
      }

      // migrate TOD/Weekend markups from < v5.4.0
      if (this.getSettings().level < '5.4.0') {
        const old = this.getSettings();
        const fixedMarkupWeekend = old.weekendHasNightMarkup ? old.fixedMarkupNight : 0;
        let fixedMarkupTOD = '';
        const start6 = old.fixedMarkupDay ? old.fixedMarkupDay : 0;
        const start22 = old.fixedMarkupNight ? old.fixedMarkupNight : 0;
        if (start6 || start22) fixedMarkupTOD = `6:${start6};22:${start22}`;
        await this.setSettings({ fixedMarkupTOD, fixedMarkupWeekend }).catch(this.error);
        this.log(this.getName(), 'TOD/Weekend markups migrated to', { fixedMarkupTOD, fixedMarkupWeekend });
      }

      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = this[sym];
      // check and repair incorrect capability(order)
      const correctCaps = this.driver.ds.deviceCapabilities;
      for (let index = 0; index < correctCaps.length; index += 1) {
        const caps = await this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          this.setUnavailable('Device is migrating. Please wait!').catch(this.error);
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i])
              .catch((error) => this.log(error));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          this.log(`adding capability ${newCap} for ${this.getName()}`);
          await this.addCapability(newCap);
          // restore capability state
          if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
          // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
          await this.setCapability(newCap, state[newCap]);
          await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          this.currencyChanged = true;
        }
      }
      if (this.getSettings().level < '4.9.1') this.currencyChanged = true;
      // check this.settings.fetchExchangeRate  < 4.4.1
      if (this.settings.level < '4.4.1') {
        this.log('migrating fixed markup to exclude exchange rate');
        await this.setSettings({ fixedMarkup: this.settings.fixedMarkup * this.settings.exchangeRate }).catch(this.error);
      }
      // convert sendTariff to tariff_update_group <4.7.1
      if (this.getSettings().level < '4.7.1') {
        const group = this.getSettings().sendTariff ? 1 : 0;
        this.log(`Migrating tariff group for ${this.getName()} to ${group}`);
        await this.setSettings({ tariff_update_group: group }).catch(this.error);
      }
      // set new migrate level
      await this.setSettings({ level: this.homey.app.manifest.version }).catch(this.error);
      this.settings = await this.getSettings();
      this.migrated = true;
      Promise.resolve(this.migrated);
    } catch (error) {
      this.error('Migration failed', error);
      Promise.reject(error);
    }
  }

  async migrateCurrencyOptions(currency, decimals) {
    this.log('migrating capability options');
    this.setUnavailable('Device is migrating. Please wait!').catch(this.error);
    const options = {
      units: { en: currency },
      decimals,
    };
    if (!currency || currency === '') options.units.en = '€';
    if (!Number.isInteger(decimals)) options.decimals = 4;
    const moneyCaps = this.driver.ds.deviceCapabilities.filter((name) => name.includes('meter_price'));
    for (let i = 0; i < moneyCaps.length; i += 1) {
      this.log(`migrating ${moneyCaps[i]} to use ${options.units.en} and ${options.decimals} decimals`);
      await this.setCapabilityOptions(moneyCaps[i], options).catch(this.error);
      await setTimeoutPromise(2 * 1000);
    }
    this.currencyChanged = false;
    // this.log('capability options migration ready', this.getCapabilityOptions('meter_price_h7'));
  }

  // STANDARD HOMEY STUFF
  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    await this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    // this.setUnavailable('Device is restarting. Wait a few minutes!').catch(this.error);
    await setTimeoutPromise(dly).then(() => this.onInit());
  }

  async onAdded() {
    this.log(`Meter added as device: ${this.getName()}`);
  }

  async onDeleted() {
    await this.destroyListeners().catch(this.error);
    this.log(`Meter deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Meter renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) { // , oldSettings) {
    if (!this.initReady) throw Error('device is not ready. Ignoring new settings!');
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (changedKeys.includes('fixedMarkupTOD')) {
      todMap(newSettings.fixedMarkupTOD); // throw error when invalid
    }
    if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
      this.currencyChanged = true;
    }
    await this.restartDevice(1000).catch(this.error);
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      // only update changed capabilities
      if (value !== await this.getCapabilityValue(capability)) {
        this.setCapabilityValue(capability, value)
          .catch((error) => {
            this.error(error, capability, value);
          });
      }
    }
  }

  // GENERIC HELPERS
  async markUpPrices(marketPrices) { // add markUp for price array, and convert price per mWh>kWh
    if (!marketPrices || !marketPrices[0]) return [];
    const muPrices = marketPrices.map((marketPrice) => {
      // handle exchange rate and convert from mWh to kWh
      let muPrice = (marketPrice.price * this.settings.exchangeRate) / 1000;
      // add variable markup
      let { variableMarkup, variableMarkupAbsPrice } = this.settings;
      variableMarkupAbsPrice = (marketPrice.price < 0) ? -variableMarkupAbsPrice : variableMarkupAbsPrice;
      if (variableMarkupAbsPrice) variableMarkup += variableMarkupAbsPrice;
      muPrice *= (1 + variableMarkup / 100);
      // add fixed markup
      const { fixedMarkup } = this.settings;
      muPrice += fixedMarkup;
      // add ToD and weekend fixed markups
      const priceDate = new Date(new Date(marketPrice.time).toLocaleString('en-US', { timeZone: this.timeZone }));
      const isWeekend = priceDate.getDay() === 0 || priceDate.getDay() === 6; // 0 = sunday, 6 = saturday
      const { fixedMarkupWeekend } = this.settings;
      if (fixedMarkupWeekend && isWeekend) muPrice += fixedMarkupWeekend;
      else if (this.todMarkups) muPrice += this.todMarkups[priceDate.getHours().toString()];
      return {
        time: marketPrice.time,
        price: marketPrice.price,
        muPrice,
      };
    });
    return muPrices;
  }

  getUTCPeriods() { // get UTC start of yesterday, today and tomorrow according to local Homey timezone
    const now = new Date();
    now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
    const homeyOffset = nowLocal - now;
    // this hour start in UTC
    const hourStart = new Date(nowLocal);
    hourStart.setMinutes(0);
    hourStart.setSeconds(0);
    hourStart.setMilliseconds(-homeyOffset); // convert back to UTC
    // this day start in UTC
    const todayStart = new Date(nowLocal);
    todayStart.setHours(0);
    todayStart.setMinutes(0);
    todayStart.setSeconds(0);
    todayStart.setMilliseconds(-homeyOffset); // convert back to UTC
    // yesterday start in UTC
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    // tomorrow start in UTC
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    // tomorrow end in UTC
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1); //  NEED TO CHECK THIS!!! IS ACTUALLY START OF NEXT DAY?
    // get the present hour (0 - 23)
    const H0 = nowLocal.getHours();
    // get day of month (1 - 31) and month of year (0 - 11);
    const monthNumber = nowLocal.getMonth();
    const dayNumber = nowLocal.getDate();
    // get total days in this month (1 - 31)
    // const month = nowLocal.getMonth(); // Get the current month (0-indexed)
    // const year = nowLocal.getFullYear();
    // const nextMonth = new Date(year, month + 1, 1);  // Set a date to the first day of the next month
    // const lastDay = new Date(nextMonth.getTime() - 1); // Subtract one day to get the last day of the current month
    // const daysThisMonth = lastDay.getDate();   // Get the number of days in the current month
    return {
      now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd, dayNumber, monthNumber,
    };
  }

  // EXECUTORS FOR ACTION FLOWS
  async createPricesJSON(period) {
    this.log('Creating prices JSON via flow', this.getName(), period);

    let prices = this.state.pricesNextHours;
    if (period === 'tomorrow') prices = this.state.pricesTomorrow;
    if (period === 'this_day') prices = this.state.pricesThisDay;
    if (!prices) throw Error('No prices available');
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(({ ...roundedPrices }));
    const tokens = { prices: priceString };
    return tokens;
  }

  async setVariableMarkup(val) {
    this.log('changing variable markup via flow', this.getName(), val);
    await this.setSettings({ variableMarkup: val }).catch(this.error);
    await this.restartDevice(1000).catch(this.error);
  }

  async setFixedMarkup(val) {
    this.log('changing fixed markup via flow', this.getName(), val);
    await this.setSettings({ fixedMarkup: val }).catch(this.error);
    await this.restartDevice(1000).catch(this.error);
  }

  async setFixedMarkupTOD(val) {
    this.log('changing Time Of Day markup via flow', this.getName(), val);
    const todObject = todMap(val); // will throw Error if invalid
    if (todObject === null) await this.setSettings({ fixedMarkupTOD: '' }).catch(this.error);
    else await this.setSettings({ fixedMarkupTOD: val }).catch(this.error);
    await this.restartDevice(1000).catch(this.error);
  }

  async setFixedMarkupWeekend(val) {
    this.log('changing Weekend markup via flow', this.getName(), val);
    if (!Number.isFinite(val)) throw Error('value is not a number');
    await this.setSettings({ fixedMarkupWeekend: val }).catch(this.error);
    await this.restartDevice(1000).catch(this.error);
  }

  async setExchangeRate(val) {
    this.log('changing exchange rate via flow', this.getName(), val);
    await this.setSettings({ exchangeRate: val }).catch(this.error);
    await this.restartDevice(1000).catch(this.error);
  }

  // EXECUTORS FOR CONDITION FLOWS AND TRIGGERS
  async priceIsLowest(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    let minimum = Math.min(...this.state.pricesThisDay);
    if (args.period !== 'this_day') minimum = Math.min(...this.state.pricesNext8h.slice(0, Number(args.period)));
    return this.state.priceNow <= minimum;
  }

  async priceIsLowestToday(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // sort and select number of lowest prices
    const lowestNPrices = [...this.state.pricesThisDay].sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // calculate start and end hours compared to present hour
    const thisHour = this.state.H0; // e.g. 23 hrs // eg2: 13 // eg3: 1
    // let thisHourIndex = thisHour;
    let endHour = args.time; // e.g. 2 hrs // eg2: 18 // eg3 = 3
    if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
    let startHour = endHour - args.period; // e.g. 26 - 4 - 1 = 22 hrs // eg2: 18 - 4 = 14 // eg3: 3 - 4 = -1
    // check if present hour is in scope op selected period
    if ((thisHour >= endHour) || (thisHour < startHour)) return false;
    // get period n-hours pricing before end time
    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour); // eg3: [h23]
      // thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
    // sort and select number of lowest prices
    const lowestNPrices = pricesTotalPeriod.sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestAvgBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // calculate start and end hours compared to present hour
    const thisHour = this.state.H0; // e.g. 23 hrs // 1
    let thisHourIndex = thisHour;
    let endHour = args.time; // e.g. 2 hrs // 8
    if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
    let startHour = endHour - args.period; // e.g. 26 - 4 - 1 = 21 hrs // 8 - 7 = 1
    // check if present hour is in scope op selected period
    if ((thisHour >= endHour) || (thisHour < startHour)) return false;
    // get period n-hours pricing before end time
    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour); // 1..7
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
    // calculate all avg prices for x hour periods before end time
    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => { // idx = 0..6
      if (index > pricesTotalPeriod.length - Number(args.hours)) return; // stop when idx > 7 - 2 = 5
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => a.avgPrice - b.avgPrice);
    thisHourIndex -= startHour;
    // console.log(minAvgHours, thisHourIndex);
    return (thisHourIndex >= minAvgHours[0].idxMin) && (thisHourIndex <= minAvgHours[0].idxMax);
  }

  async priceIsLowestNextHours(args) {
    if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
    // select number of coming hours
    const period = args.period ? args.period : 99;
    const comingXhours = [...this.state.pricesNextHours].slice(0, period);
    // sort and select number of lowest prices
    const lowestNPrices = comingXhours.sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.state.pricesThisDay] : [...this.state.pricesNext8h];
    const thisHourIndex = (args.period === 'this_day') ? this.state.H0 : 0;
    // calculate all avg prices for x hour periods before end time
    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => a.avgPrice - b.avgPrice);
    // console.log(minAvgHours, thisHourIndex);
    return ((thisHourIndex >= minAvgHours[0].idxMin) && (thisHourIndex <= minAvgHours[0].idxMax));
  }

  async priceIsHighest(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    let maximum = Math.max(...this.state.pricesThisDay);
    if (args.period !== 'this_day') maximum = Math.max(...this.state.pricesNext8h.slice(0, Number(args.period)));
    return this.state.priceNow >= maximum;
  }

  async priceIsHighestToday(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // sort and select number of highest prices
    const highestNPrices = [...this.state.pricesThisDay].sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestNextHours(args) {
    if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
    // select number of coming hours
    const comingXhours = [...this.state.pricesNextHours].slice(0, args.period);
    // sort and select number of highest prices
    const highestNPrices = comingXhours.sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // calculate start and end hours compared to present hour
    const thisHour = this.state.H0; // e.g. 23 hrs
    // let thisHourIndex = thisHour;
    let endHour = args.time; // e.g. 2 hrs
    if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
    let startHour = endHour - args.period; // e.g. 26 - 4 - 1 = 21 hrs
    // check if present hour is in scope op selected period
    if ((thisHour >= endHour) || (thisHour < startHour)) return false;
    // get period n-hours pricing before end time
    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      // thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
    // sort and select number of lowest prices
    const highestNPrices = pricesTotalPeriod.sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // args.period: '8' or 'this_day'  // args.hours: '2', '3', '4', '5' or '6'
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.state.pricesThisDay] : [...this.state.pricesNext8h];
    const thisHourIndex = (args.period === 'this_day') ? this.state.H0 : 0;
    // calculate all avg prices for x hour periods before end time
    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => b.avgPrice - a.avgPrice); // highest first
    // console.log(minAvgHours, thisHourIndex);
    return ((thisHourIndex >= minAvgHours[0].idxMin) && (thisHourIndex <= minAvgHours[0].idxMax));
  }

  async priceIsHighestAvgBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    // calculate start and end hours compared to present hour
    const thisHour = this.state.H0; // e.g. 23 hrs // 1
    let thisHourIndex = thisHour;
    let endHour = args.time; // e.g. 2 hrs // 8
    if (endHour < thisHour) endHour += 24; // e.g. 2 + 24 = 26 hrs ( = tomorrow!)
    let startHour = endHour - args.period; // e.g. 26 - 4 - 1 = 21 hrs // 8 - 7 = 1
    // check if present hour is in scope op selected period
    if ((thisHour >= endHour) || (thisHour < startHour)) return false;
    // get period n-hours pricing before end time
    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour); // 1..7
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];
    // calculate all avg prices for x hour periods before end time
    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => { // idx = 0..6
      if (index > pricesTotalPeriod.length - Number(args.hours)) return; // stop when idx > 7 - 2 = 5
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = (hours.reduce((a, b) => a + b, 0)) / hours.length;
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const maxAvgHours = avgPricesTotalPeriod.sort((a, b) => b.avgPrice - a.avgPrice);
    thisHourIndex -= startHour;
    // console.log(minAvgHours, thisHourIndex);
    return (thisHourIndex >= maxAvgHours[0].idxMin) && (thisHourIndex <= maxAvgHours[0].idxMax);
  }

  async priceIsBelowAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const percent = 100 * (1 - this.state.priceNow / this.state[args.period]);
    return percent >= Number(args.percent);
  }

  async priceIsAboveAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const percent = 100 * (this.state.priceNow / this.state[args.period] - 1);
    return percent >= Number(args.percent);
  }

  async newPricesReceived(prices, period) {
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(({ ...roundedPrices }));
    const tokens = { prices: priceString };
    const state = { period };
    this.log(`${this.getName()} received new prices for ${period}`, roundedPrices);
    this.homey.app.newPrices(this, tokens, state);
  }

  // MAIN FUNCTIONS
  async fetchExchangeRate() {
    try {
      const currency = this.settings.fetchExchangeRate;
      if (currency !== 'NONE') {
        this.log(`fetching exchange rate with ${currency}`);
        const rates = await this.exchange.getRates();
        const val = rates[this.settings.fetchExchangeRate];
        if (typeof val !== 'number') throw Error('result is not a number', val);
        if (val !== this.settings.exchangeRate) {
          this.log('new exchange rate:', val);
          await this.setSettings({ exchangeRate: val }).catch(this.error);
          this.settings = await this.getSettings();
          // recalculate and store prices based on new exchange rate
          if (this.rawCombinedPrices) await this.storePrices(this.rawCombinedPrices); // use raw prices!
        }
      }
    } catch (error) {
      this.error(error);
    }
  }

  // compare if new fetched market prices are same as old ones for given period, and trigger flow
  async checkNewMarketPrices(oldPrices, newPrices, period, periods) {
    // setup period this_day, tomorrow or next_hours
    let start = periods.todayStart;
    let end = periods.tomorrowStart;
    if (period === 'tomorrow') {
      start = periods.tomorrowStart;
      end = periods.tomorrowEnd;
    }
    if (period === 'next_hours') {
      start = periods.hourStart;
      end = 8640000000000000; // periods.tomorrowEnd;
    }
    const oldPricesSelection = oldPrices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end);
    const newPricesSelection = newPrices
      .filter((hourInfo) => new Date(hourInfo.time) >= start)
      .filter((hourInfo) => new Date(hourInfo.time) < end);

    // check for DST change or incomplete info
    if (period !== 'next_hours'
      && newPricesSelection.length !== 24) this.log(`${this.getName()} received ${newPricesSelection.length} hours of prices for ${period}`);

    // check for same pricing content
    let samePrices = true;
    newPricesSelection.forEach((newHourPrice, index) => {
      if (oldPricesSelection[index] && oldPricesSelection[index].price !== undefined) {
        samePrices = samePrices && (newHourPrice.price === oldPricesSelection[index].price);
      } else samePrices = false;
    });

    // trigger flow
    if (!samePrices) {
      let prices = await this.markUpPrices([...newPricesSelection]); // add sales prices
      prices = selectPrices(prices, start, end); // map only sales prices
      await this.newPricesReceived(prices, period); // trigger flow
    }
  }

  // check validity of new fetched pricing data
  async checkPricesValidity(newMarketPrices, periods) {
    if ((!newMarketPrices || !newMarketPrices[0] || !newMarketPrices[0].time)) throw Error('Unable to fetch prices');
    // check if tomorrow is missing
    const marketPricesNextHours = newMarketPrices.filter((hourInfo) => hourInfo.time >= periods.hourStart);
    if (marketPricesNextHours.length < 10) throw Error('Unable to fetch tomorrow prices');
    // check if hours are consecutive
    let previousHour = new Date(newMarketPrices[0].time);
    let consecutive = true;
    newMarketPrices.forEach((price, idx) => {
      if (idx !== 0) {
        consecutive = consecutive && (new Date(price.time) - previousHour) === (1000 * 60 * 60);
        previousHour = new Date(price.time);
      }
    });
    if (!consecutive) {
      this.log(this.getName(), newMarketPrices);
      throw Error('Fetched prices are not in consecutive order');
    }
    // check if latest info is not older then before
    const oldPrices = [...this.prices];
    if (oldPrices && oldPrices[0] && oldPrices[0].time) {
      if (newMarketPrices.slice(-1).time < oldPrices.slice(-1).time) throw Error('Fetched prices are older then the stored prices');
    }
    return true;
  }

  async fetchPrices() {
    try {
      this.log(this.getName(), 'fetching prices of today and tomorrow (when available)');
      // fetch prices with retry and backup
      const periods = this.getUTCPeriods(); // now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd
      if (!this.dap[0]) throw Error('no available DAP');
      let newMarketPrices;
      for (let index = 0; index < this.dap.length; index += 1) {
        newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd })
          .catch(this.log);
        const valid = await this.checkPricesValidity(newMarketPrices, periods).catch(this.log);
        if (!valid) {
          this.log(`${this.getName()} Error fetching prices from ${this.dap[index].host}. Trying again in 10 minutes`);
          await setTimeoutPromise(10 * 60 * 1000, 'waiting is done');
          newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd: periods.tomorrowEnd })
            .catch(this.log);
        } else {
          if (index !== 0) this.log('prices are not from primary service', this.dap[index].host);
          break;
        }
      }
      await this.checkPricesValidity(newMarketPrices, periods);

      // add forecast pricing
      let newForecastPrices;
      let newCombinedPrices = [...newMarketPrices];
      if (this.settings.forecastEnable && this.dapForecast && newMarketPrices && newMarketPrices[0]) {
        this.log(this.getName(), 'fetching forecast prices (when available)');
        let forecast = await this.dapForecast.getPrices({ forecast: true }).catch(this.log);
        const lastMarketTime = newMarketPrices.slice(-1)[0].time;
        forecast = forecast // remove doubles and limit to 24hrs forecast
          .filter((hourInfo) => hourInfo.time > lastMarketTime)
          .slice(0, 24);
        const combined = newMarketPrices.concat(forecast);
        const valid = await this.checkPricesValidity(combined, periods).catch(this.error);
        if (valid) {
          newForecastPrices = forecast;
          newCombinedPrices = combined;
        } else { // try retrieving forecast from store
          forecast = [...this.rawCombinedPrices] // remove doubles and limit to 24hrs forecast
            .filter((hourInfo) => hourInfo.time > lastMarketTime)
            .slice(0, 24);
          const combined2 = newMarketPrices.concat(forecast);
          const valid2 = await this.checkPricesValidity(combined2, periods).catch(this.error);
          if (valid2) {
            newForecastPrices = forecast;
            newCombinedPrices = combined;
          }
        }
      }

      // store the new prices and update state, capabilities and price graphs
      const oldPrices = [...this.prices];
      await this.storePrices(newCombinedPrices, newMarketPrices, newForecastPrices);
      await this.setCapabilitiesAndFlows({ noTriggers: true });

      // check if new prices received and trigger flows
      await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'this_day', periods);
      await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'tomorrow', periods);
      await this.checkNewMarketPrices(oldPrices, newCombinedPrices, 'next_hours', periods);
    } catch (error) {
      this.error(error);
    }
  }

  // add markup and store new prices { time , price , muPrice  }
  async storePrices(newCombinedPrices, newMarketPrices, newForecastPrices) {
    try {
      const muPrices = await this.markUpPrices([...newCombinedPrices]);
      this.prices = [...muPrices];
      this.rawCombinedPrices = [...newCombinedPrices];
      await this.setStoreValue('prices', [...muPrices]);
      if (newMarketPrices) {
        const muMarketPrices = await this.markUpPrices([...newMarketPrices]);
        this.marketPrices = [...muMarketPrices];
      }
      if (newForecastPrices) {
        const muForecastPrices = await this.markUpPrices([...newForecastPrices]);
        this.forecastPrices = [...muForecastPrices];
      }
    } catch (error) {
      this.error(error);
    }
  }

  // calculate price state for different periods, and store it
  async setState() {
    if (!this.prices || !this.prices[0] || !this.prices[0].time) throw Error('no price info available');
    const periods = this.getUTCPeriods(); // now, nowLocal, homeyOffset, H0, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd

    // pricesYesterday
    const pricesYesterday = selectPrices(this.prices, periods.yesterdayStart, periods.todayStart);

    // pricesToday, avg, lowest and highest
    const pricesThisDay = selectPrices(this.prices, periods.todayStart, periods.tomorrowStart);
    const priceThisDayAvg = average(pricesThisDay);
    const priceThisDayLowest = Math.min(...pricesThisDay);
    const hourThisDayLowest = pricesThisDay.indexOf(priceThisDayLowest);
    const priceThisDayHighest = Math.max(...pricesThisDay);
    const hourThisDayHighest = pricesThisDay.indexOf(priceThisDayHighest);

    // priceNow, hourNow
    const { H0 } = periods; // the present hour (0 - 23)
    let [priceNow] = selectPrices(this.prices, periods.hourStart, periods.tomorrowStart);
    if (priceNow === undefined) priceNow = null;

    // avg prices this month and last month
    const { dayNumber, monthNumber } = periods;
    const lastDayNumber = this.getStoreValue('lastDayNumber'); // retrieve from persistent memory
    const lastMonthNumber = this.getStoreValue('lastMonthNumber'); // retrieve from persistent memory
    let priceThisMonthAvg = this.getCapabilityValue('meter_price_this_month_avg');
    let priceLastMonthAvg = this.getCapabilityValue('meter_price_last_month_avg');
    if (lastDayNumber !== dayNumber) { // new day started or device init
      if (monthNumber !== lastMonthNumber || dayNumber === 1) { // new month started or device init
        priceLastMonthAvg = priceThisMonthAvg;
        priceThisMonthAvg = priceThisDayAvg;
        await this.setStoreValue('lastMonthNumber', monthNumber);
      } else { // add weighted average
        priceThisMonthAvg = (priceThisDayAvg + priceThisMonthAvg * (dayNumber - 1)) / dayNumber;
      }
      await this.setStoreValue('lastDayNumber', dayNumber);
    }

    // pricesNext All Known Hours
    const pricesNextHours = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.hourStart)
      .map((hourInfo) => hourInfo.muPrice);
    const pricesNextHoursMarketLength = this.marketPrices.filter((hourInfo) => hourInfo.time >= periods.hourStart).length;

    // pricesNext8h, avg, lowest and highest
    const pricesNext8h = pricesNextHours.slice(0, 8);
    const priceNext8hAvg = average(pricesNext8h);
    const priceNext8hLowest = Math.min(...pricesNext8h);
    const hourNext8hLowest = (H0 + pricesNext8h.indexOf(priceNext8hLowest)) % 24;
    const priceNext8hHighest = Math.max(...pricesNext8h);
    const hourNext8hHighest = (H0 + pricesNext8h.indexOf(priceNext8hHighest)) % 24;

    // pricesTomorrow, avg, lowest and highest
    const pricesTomorrow = selectPrices(this.prices, periods.tomorrowStart, periods.tomorrowEnd);
    const pricesTomorrowMarketLength = selectPrices(this.marketPrices, periods.tomorrowStart, periods.tomorrowEnd).length;
    let priceNextDayAvg = null;
    let priceNextDayLowest = null;
    let hourNextDayLowest = null;
    let priceNextDayHighest = null;
    let hourNextDayHighest = null;
    if (pricesTomorrow.length > 6) {
      priceNextDayAvg = average(pricesTomorrow);
      priceNextDayLowest = Math.min(...pricesTomorrow);
      hourNextDayLowest = pricesTomorrow.indexOf(priceNextDayLowest);
      priceNextDayHighest = Math.max(...pricesTomorrow);
      hourNextDayHighest = pricesTomorrow.indexOf(priceNextDayHighest);
    }

    const state = {
      pricesYesterday,

      priceLastMonthAvg,
      priceThisMonthAvg,
      dayNumber,
      monthNumber,

      pricesThisDay,
      priceThisDayAvg,
      this_day_avg: priceThisDayAvg,
      priceThisDayLowest,
      hourThisDayLowest,
      priceThisDayHighest,
      hourThisDayHighest,

      pricesNextHours,
      pricesNextHoursMarketLength,

      pricesNext8h,
      priceNext8hAvg,
      next_8h_avg: priceNext8hAvg,
      priceNext8hLowest,
      hourNext8hLowest,
      priceNext8hHighest,
      hourNext8hHighest,

      priceNow,
      H0,

      pricesTomorrow,
      pricesTomorrowMarketLength,
      priceNextDayAvg,
      priceNextDayLowest,
      hourNextDayLowest,
      priceNextDayHighest,
      hourNextDayHighest,
    };
    this.state = state;
  }

  async updatePriceCharts() {
    const urlToday = await charts.getPriceChart(this.state.pricesThisDay);
    if (!this.todayPriceImage) {
      this.todayPriceImage = await this.homey.images.createImage();
      await this.todayPriceImage.setUrl(urlToday);
      await this.setCameraImage('todayPriceChart', ` ${this.homey.__('today')}`, this.todayPriceImage);
    } else {
      await this.todayPriceImage.setUrl(urlToday);
      await this.todayPriceImage.update();
    }

    const urlTomorow = await charts.getPriceChart(this.state.pricesTomorrow, 0, this.state.pricesTomorrowMarketLength);
    if (!this.tomorrowPriceImage) {
      this.tomorrowPriceImage = await this.homey.images.createImage();
      await this.tomorrowPriceImage.setUrl(urlTomorow);
      await this.setCameraImage('tomorrowPriceChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowPriceImage);
    } else {
      await this.tomorrowPriceImage.setUrl(urlTomorow);
      await this.tomorrowPriceImage.update();
    }

    const urlNextHours = await charts.getPriceChart(this.state.pricesNextHours, this.state.H0, this.state.pricesNextHoursMarketLength);
    if (!this.nextHoursPriceImage) {
      this.nextHoursPriceImage = await this.homey.images.createImage();
      await this.nextHoursPriceImage.setUrl(urlNextHours);
      await this.setCameraImage('nextHoursPriceChart', ` ${this.homey.__('nextHours')}`, this.nextHoursPriceImage);
    } else {
      await this.nextHoursPriceImage.setUrl(urlNextHours);
      await this.nextHoursPriceImage.update();
    }
  }

  async setCapabilitiesAndFlows(options) {
    try {
      const oldState = this.state || {};
      await this.setState();

      // set capabilities
      await this.setCapability('meter_price_this_day_lowest', this.state.priceThisDayLowest);
      await this.setCapability('hour_this_day_lowest', this.state.hourThisDayLowest);
      await this.setCapability('meter_price_next_8h_lowest', this.state.priceNext8hLowest);
      await this.setCapability('hour_next_8h_lowest', this.state.hourNext8hLowest);
      await this.setCapability('meter_price_this_day_highest', this.state.priceThisDayHighest);
      await this.setCapability('hour_this_day_highest', this.state.hourThisDayHighest);
      await this.setCapability('meter_price_next_8h_highest', this.state.priceNext8hHighest);
      await this.setCapability('hour_next_8h_highest', this.state.hourNext8hHighest);
      await this.setCapability('meter_price_this_day_avg', this.state.priceThisDayAvg);
      await this.setCapability('meter_price_this_month_avg', this.state.priceThisMonthAvg);
      await this.setCapability('meter_price_last_month_avg', this.state.priceLastMonthAvg);
      await this.setCapability('meter_price_next_8h_avg', this.state.priceNext8hAvg);
      await this.setCapability('meter_price_next_day_lowest', this.state.priceNextDayLowest);
      await this.setCapability('hour_next_day_lowest', this.state.hourNextDayLowest);
      await this.setCapability('meter_price_next_day_highest', this.state.priceNextDayHighest);
      await this.setCapability('hour_next_day_highest', this.state.hourNextDayHighest);
      await this.setCapability('meter_price_next_day_avg', this.state.priceNextDayAvg);

      const rankThisDay = [...this.state.pricesThisDay]
        .sort((a, b) => a - b)
        .findIndex((val) => val === this.state.priceNow);
      const rankNext8h = [...this.state.pricesNext8h]
        .sort((a, b) => a - b)
        .findIndex((val) => val === this.state.priceNow);
      await this.setCapability('meter_rank_price_h0_this_day', rankThisDay + 1);
      await this.setCapability('meter_rank_price_h0_next_8h', rankNext8h + 1);

      const allSet = this.state.pricesNext8h.map((price, index) => this.setCapability(`meter_price_h${index}`, price).catch(this.error));
      await Promise.all(allSet);

      // send tariff to power or gas summarizer driver
      const sendTo = (this.driver.ds.driverId === 'dapg') ? 'set_tariff_gas' : 'set_tariff_power';
      const group = this.settings.tariff_update_group;
      if (group) {
        this.homey.emit(sendTo, {
          tariff: this.state.priceNow,
          pricesNextHours: this.state.pricesNextHours,
          pricesNextHoursMarketLength: this.state.pricesNextHoursMarketLength,
          group,
        });
      }

      // update the price graphs
      await this.updatePriceCharts().catch(this.error);

      // trigger new hour started, or app restart
      if (this.state.H0 !== oldState.H0) {
        const tokens = { H0: this.state.H0, price: this.state.priceNow };
        this.homey.app.triggerNewHour(this, tokens);
      }
      // trigger flow cards, except after fetch new prices
      if (!options || !options.noTriggers) {
        // trigger new nextHours prices every hour
        if (this.state.pricesNextHours && this.state.pricesNextHours[0]) {
          await this.newPricesReceived(this.state.pricesNextHours, 'next_hours').catch(this.error);
        }
        // trigger new prices received right after midnight
        if (this.state.H0 === 0) {
          if (this.state.pricesThisDay && this.state.pricesThisDay[0]) {
            await this.newPricesReceived(this.state.pricesThisDay, 'this_day').catch(this.error);
          }
          if (this.state.pricesTomorrow && this.state.pricesTomorrow[0]) {
            await this.newPricesReceived(this.state.pricesTomorrow, 'tomorrow').catch(this.error);
          }
        }
        // trigger other price related flows
        if (Number.isFinite(this.state.priceNow)) {
          const tokens = { meter_price_h0: Number(this.state.priceNow.toFixed(this.settings.decimals)) };
          const state = { ...this.state };
          this.homey.app.triggerPriceHighest(this, tokens, state);
          this.homey.app.triggerPriceHighestBefore(this, tokens, state);
          this.homey.app.triggerPriceHighestToday(this, tokens, state);
          this.homey.app.triggerPriceAboveAvg(this, tokens, state);
          this.homey.app.triggerPriceHighestAvg(this, tokens, state);
          this.homey.app.triggerPriceLowest(this, tokens, state);
          this.homey.app.triggerPriceLowestBefore(this, tokens, state);
          this.homey.app.triggerPriceLowestToday(this, tokens, state);
          this.homey.app.triggerPriceBelowAvg(this, tokens, state);
          this.homey.app.triggerPriceLowestAvg(this, tokens, state);
          this.homey.app.triggerPriceLowestAvgBefore(this, tokens, state);
          this.homey.app.triggerPriceHighestAvgBefore(this, tokens, state);
        }
      }
    } catch (error) {
      this.error(error);
    }
  }

}

module.exports = MyDevice;
