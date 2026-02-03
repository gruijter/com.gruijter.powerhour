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

const Homey = require('homey');
const util = require('util');
const crypto = require('crypto');
const ECB = require('./providers/ECB');
const FORECAST = require('./providers/Stekker');
const charts = require('./Charts');
const { imageUrlToStream } = require('./ImageHelpers');
const PriceCalculator = require('./PriceCalculator');

const setTimeoutPromise = util.promisify(setTimeout);

class MyDevice extends Homey.Device {

  // INIT STUFF
  async onInitDevice() {
    try {
      await this.destroyListeners();
      this.restarting = false;
      this.initReady = false;
      this.sessionId = crypto.randomBytes(4).toString('hex');
      const currentSessionId = this.sessionId;
      this.settings = await this.getSettings();
      this.timeZone = this.homey.clock.getTimezone();
      this.fetchDelay = (Math.random() * 5 * 60 * 1000) + (1000 * 60 * 0.5); // random delay between 30 sec and 5 minutes to spread API calls on app start

      // restore from persistent memory on app restart
      this.prices = this.getStoreValue('prices') || [{ time: null, price: null, muPrice: null }];
      this.marketPrices = this.marketPrices || [];
      this.rawCombinedPrices = this.rawCombinedPrices || [];

      this.priceInterval = 60; // default 1 hour
      if (this.driver.id === 'dap15') this.priceInterval = 15;
      if (this.driver.id === 'dap30') this.priceInterval = 30;

      // check migrations
      if (!this.migrated) await this.migrate();
      if (this.currencyChanged) await this.migrateCurrencyOptions(this.settings.currency, this.settings.decimals);

      // calculate todMarkups for validation
      this.todMarkups = PriceCalculator.parseTOD(this.settings.fixedMarkupTOD);

      // setup exchange rate api
      this.exchange = new ECB();

      // setup pricing providers
      this.dap = [];
      const providers = this.driver.ds.providers.filter((Provider) => { // select providers that support this bidding zone
        const dap = new Provider();
        const zones = dap.getBiddingZones();
        return Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
      });

      let apiKey = '';
      providers.forEach((Provider, index) => {
        if (Provider.name === 'ENTSOE_GRUIJTER') apiKey = Homey?.env?.ENTSOE_GRUIJTER_API_KEY;
        else if (Provider.name === 'ENTSOE') apiKey = Homey?.env?.ENTSOE_API_KEY;
        this.dap[index] = new Provider({ apiKey, biddingZone: this.settings.biddingZone });
      });

      if (!this.dap[0]) {
        this.error(this.getName(), 'no provider found for bidding zone', this.settings.biddingZone);
        return;
      }

      // add forecast pricing provider
      if ((this.driver.id === 'dap') && this.settings.forecastEnable) {
        const forecast = new FORECAST();
        const zones = forecast.getBiddingZones();
        const hasZone = Object.keys(zones).some((key) => zones[key].includes(this.settings.biddingZone));
        if (hasZone) this.dapForecast = new FORECAST({ biddingZone: this.settings.biddingZone });
      }

      // fetch and handle prices now, after short random delay
      await this.setAvailable().catch(this.error);
      await setTimeoutPromise(this.fetchDelay); // wait for sum and bat devices to be ready after app start
      if (this.sessionId !== currentSessionId) return; // stop if new session started

      await this.fetchExchangeRate();
      await this.fetchPrices();

      // start fetching and handling prices on every hour
      this.eventListenerHour = () => {
        (async () => {
          this.log('new hour event received');
          await this.fetchExchangeRate();
          await this.setCapabilitiesAndFlows();
          await setTimeoutPromise(this.fetchDelay); // spread over 15 minute for API rate limit (400 / min)
          await this.fetchPrices();
        })().catch((err) => this.error(err));
      };
      this.homey.on('everyhour_PBTH', this.eventListenerHour);

      // start handling prices every 15 minutes (dap15 only)
      if (this.driver.ds.driverId === 'dap15') {
        this.eventListener15m = () => {
          (async () => {
            this.log('new 15m event received');
            await this.setCapabilitiesAndFlows();
          })().catch((err) => this.error(err));
        };
        this.homey.on('every15m_PBTH', this.eventListener15m);
      }

      this.initReady = true;
      this.log(`${this.getName()} finished initialization`);
    } catch (error) {
      this.error(error);
      this.restartDevice(60 * 1000).catch((error) => this.error(error)); // restart after 1 minute
    }
  }

  async onUninit() {
    this.log(`Homey is killing ${this.getName()}`);
    this.sessionId = null;
    await this.destroyListeners().catch(this.error);
    let delay = 1500;
    if (!this.migrated || !this.initFirstReading) delay = 10 * 1000;
    await setTimeoutPromise(delay);
  }

  async destroyListeners() {
    if (this.eventListenerHour) await this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListener15m) await this.homey.removeListener('every15m_PBTH', this.eventListener15m);
  }

  // MIGRATE STUFF from old version < 5.0.0
  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
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
          await this.setCapability(newCap, state[newCap]);
          await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          this.currencyChanged = true;
        }
      }
      // set new migrate level
      await this.setSettings({ level: this.homey.app.manifest.version }).catch(this.error);
      this.settings = await this.getSettings();
      this.migrated = true;
      return Promise.resolve(this.migrated);
    } catch (error) {
      this.error('Migration failed', error);
      return Promise.reject(error);
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
  }

  // STANDARD HOMEY STUFF
  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    await this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly).then(() => this.onInit());
  }

  async onAdded() {
    this.log(`DAP added as device: ${this.getName()}`);
  }

  async onDeleted() {
    await this.destroyListeners().catch(this.error);
    this.log(`DAP deleted as device: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`DAP renamed to: ${name}`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!this.initReady) throw Error('device is not ready. Ignoring new settings!');
    this.log(`${this.getName()} device settings changed by user`, newSettings);

    if (changedKeys.includes('fixedMarkupTOD')) {
      PriceCalculator.parseTOD(newSettings.fixedMarkupTOD); // throw error when invalid
    }
    if (changedKeys.includes('currency') || changedKeys.includes('decimals')) {
      this.currencyChanged = true;
    }
    this.restartDevice(1000).catch((error) => this.error(error));
    return true;
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

  getUTCPeriods() { // get UTC start of yesterday, today and tomorrow according to local Homey timezone
    const now = new Date();
    now.setMilliseconds(0); // toLocaleString cannot handle milliseconds...
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
    const homeyOffset = nowLocal - now;
    // this quarter start in UTC
    const quarterStart = new Date(nowLocal);
    quarterStart.setMinutes(Math.floor(nowLocal.getMinutes() / 15) * 15);
    quarterStart.setSeconds(0);
    quarterStart.setMilliseconds(-homeyOffset); // convert back to UTC
    // this hour start in UTC
    const hourStart = new Date(nowLocal);
    hourStart.setMinutes(0);
    hourStart.setSeconds(0);
    hourStart.setMilliseconds(-homeyOffset); // convert back to UTC
    // periodStart depending on driver
    const periodStart = this.driver.id === 'dap15' ? quarterStart : hourStart;
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
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
    // get the present hour (0 - 23) and quarter (0 - 95)
    const H0 = nowLocal.getHours();
    const Q0 = (H0 * 4) + Math.floor(nowLocal.getMinutes() / 15);
    // get day of month (1 - 31) and month of year (0 - 11);
    const monthNumber = nowLocal.getMonth();
    const dayNumber = nowLocal.getDate();
    return {
      now, nowLocal, homeyOffset, H0, Q0, periodStart, quarterStart, hourStart, todayStart, yesterdayStart, tomorrowStart, tomorrowEnd, dayNumber, monthNumber,
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
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async setFixedMarkup(val) {
    this.log('changing fixed markup via flow', this.getName(), val);
    await this.setSettings({ fixedMarkup: val }).catch(this.error);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async setFixedMarkupTOD(val) {
    this.log('changing Time Of Day markup via flow', this.getName(), val);
    const todObject = PriceCalculator.parseTOD(val); // will throw Error if invalid
    if (todObject === null) await this.setSettings({ fixedMarkupTOD: '' }).catch(this.error);
    else await this.setSettings({ fixedMarkupTOD: val }).catch(this.error);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async setFixedMarkupWeekend(val) {
    this.log('changing Weekend markup via flow', this.getName(), val);
    if (!Number.isFinite(val)) throw Error('value is not a number');
    await this.setSettings({ fixedMarkupWeekend: val }).catch(this.error);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async setExchangeRate(val) {
    this.log('changing exchange rate via flow', this.getName(), val);
    await this.setSettings({ exchangeRate: val }).catch(this.error);
    this.restartDevice(1000).catch((error) => this.error(error));
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
    const lowestNPrices = [...this.state.pricesThisDay].sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const thisHour = this.state.H0;
    let endHour = args.time;
    if (endHour < thisHour) endHour += 24;
    let startHour = endHour - args.period;

    if ((thisHour >= endHour) || (thisHour < startHour)) return false;

    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

    const lowestNPrices = pricesTotalPeriod.sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestAvgBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const thisHour = this.state.H0;
    let thisHourIndex = thisHour;
    let endHour = args.time;
    if (endHour < thisHour) endHour += 24;
    let startHour = endHour - args.period;

    if ((thisHour >= endHour) || (thisHour < startHour)) return false;

    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = PriceCalculator.average(hours);
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => a.avgPrice - b.avgPrice);
    thisHourIndex -= startHour;
    return (thisHourIndex >= minAvgHours[0].idxMin) && (thisHourIndex <= minAvgHours[0].idxMax);
  }

  async priceIsLowestNextHours(args) {
    if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
    const period = args.period ? args.period : 99;
    const comingXhours = [...this.state.pricesNextHours].slice(0, period);
    const lowestNPrices = comingXhours.sort((a, b) => a - b).slice(0, args.number);
    return this.state.priceNow <= Math.max(...lowestNPrices);
  }

  async priceIsLowestAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.state.pricesThisDay] : [...this.state.pricesNext8h];
    const thisHourIndex = (args.period === 'this_day') ? this.state.H0 : 0;

    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = PriceCalculator.average(hours);
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => a.avgPrice - b.avgPrice);
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
    const highestNPrices = [...this.state.pricesThisDay].sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestNextHours(args) {
    if (!this.state || !this.state.pricesNextHours) throw Error('no prices available');
    const comingXhours = [...this.state.pricesNextHours].slice(0, args.period);
    const highestNPrices = comingXhours.sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const thisHour = this.state.H0;
    let endHour = args.time;
    if (endHour < thisHour) endHour += 24;
    let startHour = endHour - args.period;

    if ((thisHour >= endHour) || (thisHour < startHour)) return false;

    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

    const highestNPrices = pricesTotalPeriod.sort((a, b) => a - b).reverse().slice(0, args.number);
    return this.state.priceNow >= Math.min(...highestNPrices);
  }

  async priceIsHighestAvg(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.state.pricesThisDay] : [...this.state.pricesNext8h];
    const thisHourIndex = (args.period === 'this_day') ? this.state.H0 : 0;

    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = PriceCalculator.average(hours);
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const minAvgHours = avgPricesTotalPeriod.sort((a, b) => b.avgPrice - a.avgPrice);
    return ((thisHourIndex >= minAvgHours[0].idxMin) && (thisHourIndex <= minAvgHours[0].idxMax));
  }

  async priceIsHighestAvgBefore(args) {
    if (!this.state || !this.state.pricesThisDay) throw Error('no prices available');
    const thisHour = this.state.H0;
    let thisHourIndex = thisHour;
    let endHour = args.time;
    if (endHour < thisHour) endHour += 24;
    let startHour = endHour - args.period;

    if ((thisHour >= endHour) || (thisHour < startHour)) return false;

    let pricesPartYesterday = [];
    if (startHour < 0) {
      pricesPartYesterday = this.state.pricesYesterday.slice(startHour);
      thisHourIndex += pricesPartYesterday.length;
      startHour = 0;
    }
    let pricesPartTomorrow = [];
    if (endHour > 24) pricesPartTomorrow = this.state.pricesTomorrow.slice(0, endHour - 24);
    const pricesPartToday = this.state.pricesThisDay.slice(startHour, endHour);
    const pricesTotalPeriod = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

    const avgPricesTotalPeriod = [];
    pricesTotalPeriod.forEach((price, index) => {
      if (index > pricesTotalPeriod.length - Number(args.hours)) return;
      const idxMin = index;
      const idxMax = index + Number(args.hours) - 1;
      const hours = pricesTotalPeriod.slice(idxMin, (idxMax + 1));
      const avgPrice = PriceCalculator.average(hours);
      avgPricesTotalPeriod.push({ avgPrice, idxMin, idxMax });
    });
    const maxAvgHours = avgPricesTotalPeriod.sort((a, b) => b.avgPrice - a.avgPrice);
    thisHourIndex -= startHour;
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
          if (this.rawCombinedPrices) await this.storePrices(this.rawCombinedPrices);
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
      start = periods.periodStart;
      end = 8640000000000000;
    }
    const oldPricesSelection = PriceCalculator.selectPriceObjects(oldPrices, start, end);
    const newPricesSelection = PriceCalculator.selectPriceObjects(newPrices, start, end);

    if (newPricesSelection.length !== oldPricesSelection.length) {
      this.log(`${this.getName()} different number of price periods for ${period}`);
      this.log('oldPrices:', oldPricesSelection);
      this.log('newPrices:', newPricesSelection);
      if (newPricesSelection.length < oldPricesSelection.length) return;
    }

    if (period !== 'next_hours' && newPricesSelection.length !== 24) {
      this.log(`${this.getName()} received ${newPricesSelection.length} price periods for ${period}`);
    }

    let samePrices = true;
    if (newPricesSelection.length !== oldPricesSelection.length) {
      samePrices = false;
    } else {
      newPricesSelection.forEach((newHourPrice, index) => {
        if (oldPricesSelection[index] && oldPricesSelection[index].price !== undefined) {
          if (Math.abs(newHourPrice.price - oldPricesSelection[index].price) > 0.00001) {
            samePrices = false;
          }
        } else {
          samePrices = false;
        }
      });
    }

    if (!samePrices) {
      let prices = PriceCalculator.calculateMarkupPrices(newPricesSelection, this.settings, this.timeZone);
      prices = PriceCalculator.selectPrices(prices, start, end);
      await this.newPricesReceived(prices, period);
    }
  }

  // check validity of new fetched pricing data
  async checkPricesValidity(newMarketPrices, periods) {
    if ((!newMarketPrices || !newMarketPrices[0] || !newMarketPrices[0].time)) throw Error('Unable to fetch prices');
    // check if tomorrow is missing
    const marketPricesNextHours = newMarketPrices.filter((hourInfo) => hourInfo.time >= periods.periodStart);
    if (marketPricesNextHours.length < 1) throw Error('Unable to fetch current price');
    // check if intervals are consecutive
    let previousTime = new Date(newMarketPrices[0].time);
    let consecutive = true;
    const intervalMs = this.priceInterval * 60 * 1000;
    newMarketPrices.forEach((price, idx) => {
      if (idx !== 0) {
        consecutive = consecutive && (new Date(price.time) - previousTime) === intervalMs;
        previousTime = new Date(price.time);
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
      const currentSessionId = this.sessionId;
      // fetch prices with retry and backup
      const periods = this.getUTCPeriods();

      // Check if we already have valid prices for today and tomorrow
      if (this.marketPrices && this.marketPrices.length > 0) {
        const pricesTomorrow = this.marketPrices.filter((p) => new Date(p.time) >= periods.tomorrowStart && new Date(p.time) < periods.tomorrowEnd);
        const expectedItems = 24 * (60 / this.priceInterval);
        if (pricesTomorrow.length >= expectedItems) {
          this.log(this.getName(), 'Skipping fetch: Prices for tomorrow are already available.');
          return;
        }
      }

      if (!this.dap[0]) throw Error('no available DAP');
      const resolution = `PT${this.priceInterval}M`;
      let newMarketPrices;

      // New logic: determine the end date for the fetch
      let dateEnd = periods.tomorrowStart; // Default to end of today
      if (periods.nowLocal.getHours() >= 13) { // Only fetch for tomorrow after 1 PM local time
        dateEnd = periods.tomorrowEnd;
        this.log(this.getName(), 'after 13:00, trying to fetch prices for tomorrow');
      }

      for (let index = 0; index < this.dap.length; index += 1) {
        newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd, resolution })
          .catch(this.log);
        const valid = await this.checkPricesValidity(newMarketPrices, periods).catch(this.log);
        if (!valid) {
          const retryDelay = 600000 + Math.random() * 300000; // 10-15 minutes
          this.log(`${this.getName()} Error fetching prices from ${this.dap[index].host}. Trying again in ${Math.round(retryDelay / 60000)} minutes`);
          await setTimeoutPromise(retryDelay, 'waiting is done');
          if (this.sessionId !== currentSessionId) return;
          newMarketPrices = await this.dap[index].getPrices({ dateStart: periods.yesterdayStart, dateEnd, resolution })
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
          forecast = [...this.rawCombinedPrices]
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
      const muPrices = PriceCalculator.calculateMarkupPrices(newCombinedPrices, this.settings, this.timeZone);
      this.prices = [...muPrices];
      this.rawCombinedPrices = [...newCombinedPrices];
      await this.setStoreValue('prices', [...muPrices]);
      if (newMarketPrices) {
        const muMarketPrices = PriceCalculator.calculateMarkupPrices(newMarketPrices, this.settings, this.timeZone);
        this.marketPrices = [...muMarketPrices];
      }
      if (newForecastPrices) {
        const muForecastPrices = PriceCalculator.calculateMarkupPrices(newForecastPrices, this.settings, this.timeZone);
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
    const pricesYesterday = PriceCalculator.selectPrices(this.prices, periods.yesterdayStart, periods.todayStart);

    // pricesToday, avg, lowest and highest
    const pricesThisDay = PriceCalculator.selectPrices(this.prices, periods.todayStart, periods.tomorrowStart);
    const statsThisDay = PriceCalculator.calculateStats(pricesThisDay);

    // priceNow, hourNow
    const { H0, Q0 } = periods;
    const pricesNowArray = PriceCalculator.selectPrices(this.prices, periods.periodStart, periods.tomorrowStart);
    let priceNow = pricesNowArray[0];
    if (priceNow === undefined) priceNow = null;

    // avg prices this month and last month
    const { dayNumber, monthNumber } = periods;
    const lastDayNumber = this.getStoreValue('lastDayNumber');
    const lastMonthNumber = this.getStoreValue('lastMonthNumber');
    let priceThisMonthAvg = this.getCapabilityValue('meter_price_this_month_avg');
    let priceLastMonthAvg = this.getCapabilityValue('meter_price_last_month_avg');

    if (lastDayNumber !== dayNumber) { // new day started or device init
      if (monthNumber !== lastMonthNumber || dayNumber === 1) { // new month started or device init
        priceLastMonthAvg = priceThisMonthAvg;
        priceThisMonthAvg = statsThisDay.avg;
        await this.setStoreValue('lastMonthNumber', monthNumber);
      } else { // add weighted average
        priceThisMonthAvg = (statsThisDay.avg + priceThisMonthAvg * (dayNumber - 1)) / dayNumber;
      }
      await this.setStoreValue('lastDayNumber', dayNumber);
    }

    // pricesNext All Known Hours
    const pricesNextHours = this.prices
      .filter((hourInfo) => hourInfo.time >= periods.periodStart)
      .map((hourInfo) => hourInfo.muPrice);
    const pricesNextHoursMarketLength = this.marketPrices.filter((hourInfo) => hourInfo.time >= periods.periodStart).length;

    // pricesNext8h, avg, lowest and highest
    const pricesNext8h = PriceCalculator.selectPrices(this.prices, periods.periodStart, (periods.periodStart.getTime() + 8 * 60 * 60 * 1000));
    const statsNext8h = PriceCalculator.calculateStats(pricesNext8h);

    const hourNext8hLowest = (H0 + statsNext8h.minIndex) % 24;
    const hourNext8hHighest = (H0 + statsNext8h.maxIndex) % 24;

    // pricesTomorrow, avg, lowest and highest
    const pricesTomorrow = PriceCalculator.selectPrices(this.prices, periods.tomorrowStart, periods.tomorrowEnd);
    const pricesTomorrowMarketLength = PriceCalculator.selectPrices(this.marketPrices, periods.tomorrowStart, periods.tomorrowEnd).length;

    let statsNextDay = {
      min: null, max: null, avg: null, minIndex: null, maxIndex: null,
    };
    if (pricesTomorrow.length > 6) {
      statsNextDay = PriceCalculator.calculateStats(pricesTomorrow);
    }

    const state = {
      priceinterval: this.priceInterval,
      pricesYesterday,

      priceLastMonthAvg,
      priceThisMonthAvg,
      this_month_avg: priceThisMonthAvg,
      dayNumber,
      monthNumber,

      pricesThisDay,
      priceThisDayAvg: statsThisDay.avg,
      this_day_avg: statsThisDay.avg,
      priceThisDayLowest: statsThisDay.min,
      hourThisDayLowest: statsThisDay.minIndex,
      priceThisDayHighest: statsThisDay.max,
      hourThisDayHighest: statsThisDay.maxIndex,

      pricesNextHours,
      pricesNextHoursMarketLength,

      pricesNext8h,
      priceNext8hAvg: statsNext8h.avg,
      next_8h_avg: statsNext8h.avg,
      priceNext8hLowest: statsNext8h.min,
      hourNext8hLowest,
      priceNext8hHighest: statsNext8h.max,
      hourNext8hHighest,

      priceNow,
      H0,
      Q0,

      pricesTomorrow,
      pricesTomorrowMarketLength,
      priceNextDayAvg: statsNextDay.avg,
      priceNextDayLowest: statsNextDay.min,
      hourNextDayLowest: statsNextDay.minIndex,
      priceNextDayHighest: statsNextDay.max,
      hourNextDayHighest: statsNextDay.maxIndex,
    };
    this.state = state;
  }

  async updatePriceCharts() {
    const urlToday = await charts.getPriceChart(this.state.pricesThisDay, 0, 999, this.priceInterval);
    if (!this.todayPriceImage) {
      this.todayPriceImage = await this.homey.images.createImage();
      await this.setCameraImage('todayPriceChart', ` ${this.homey.__('today')}`, this.todayPriceImage);
    }
    this.todayPriceImage.setStream(async (stream) => {
      return imageUrlToStream(urlToday, stream);
    });
    await this.todayPriceImage.update();

    const urlTomorow = await charts.getPriceChart(this.state.pricesTomorrow, 0, this.state.pricesTomorrowMarketLength, this.priceInterval);
    if (!this.tomorrowPriceImage) {
      this.tomorrowPriceImage = await this.homey.images.createImage();
      await this.setCameraImage('tomorrowPriceChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowPriceImage);
    }
    this.tomorrowPriceImage.setStream(async (stream) => {
      return imageUrlToStream(urlTomorow, stream);
    });
    await this.tomorrowPriceImage.update();

    const startHour = this.priceInterval === 60 ? this.state.H0 : this.state.Q0 * (this.priceInterval / 60);
    const urlNextHours = await charts.getPriceChart(this.state.pricesNextHours, startHour, this.state.pricesNextHoursMarketLength, this.priceInterval);
    if (!this.nextHoursPriceImage) {
      this.nextHoursPriceImage = await this.homey.images.createImage();
      await this.setCameraImage('nextHoursPriceChart', ` ${this.homey.__('nextHours')}`, this.nextHoursPriceImage);
    }
    this.nextHoursPriceImage.setStream(async (stream) => {
      return imageUrlToStream(urlNextHours, stream);
    });
    await this.nextHoursPriceImage.update();
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
      const sendTo = (this.driver.ds.driverId === 'dapg') ? 'set_tariff_gas_PBTH' : 'set_tariff_power_PBTH';
      const group = this.settings.tariff_update_group;
      if (group) {
        this.homey.emit(sendTo, {
          tariff: this.state.priceNow,
          priceInterval: this.priceInterval,
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
