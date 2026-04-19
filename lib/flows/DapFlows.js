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

/* eslint-disable camelcase */

'use strict';

const PriceCalculator = require('../PriceCalculator');

class DapFlows {
  constructor(device) {
    this.device = device;
  }

  get stepsPerHour() {
    return 60 / this.device.priceInterval;
  }

  getPricesBefore(args) {
    const now = new Date();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.device.timeZone }));
    const currentStep = Math.floor((nowLocal.getHours() * 60 + nowLocal.getMinutes()) / (this.device.priceInterval || 60));

    const timeArg = args.time ?? 0;

    // Strictly resolve window size (avoid squashing window to average block size)
    const periodArg = args.period ?? args.hours ?? 0;
    const periodSteps = Math.round(Number(periodArg) * this.stepsPerHour);

    let endStep = Number(timeArg) * this.stepsPerHour;
    const stepsPerDay = 24 * this.stepsPerHour;

    if (endStep < currentStep) endStep += stepsPerDay;
    const startStep = endStep - periodSteps;

    if ((currentStep >= endStep) || (currentStep < startStep)) return null;

    const pYesterday = this.device.state.pricesYesterday || [];
    const pToday = this.device.state.pricesThisDay || [];
    const pTomorrow = this.device.state.pricesTomorrow || [];

    const prices = [];
    for (let i = startStep; i < endStep; i += 1) {
      if (i < 0) {
        const idx = pYesterday.length + i;
        if (idx >= 0 && idx < pYesterday.length) prices.push(pYesterday[idx]);
      } else if (i < stepsPerDay) {
        if (i >= 0 && i < pToday.length) prices.push(pToday[i]);
      } else {
        const idx = i - stepsPerDay;
        if (idx >= 0 && idx < pTomorrow.length) prices.push(pTomorrow[idx]);
      }
    }

    const relativeIndex = currentStep - startStep;
    return { prices, relativeIndex };
  }

  getPricesInWindow(args) {
    const { time1, time2 } = args;
    if (!this.device.state || !this.device.state.pricesThisDay) return { prices: [], isNowInWindow: false, currentIndex: -1 };

    const now = new Date();
    const { timeZone } = this.device;
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone }));
    const homeyOffset = nowLocal.getTime() - now.getTime();

    const todayLocal = new Date(nowLocal);
    todayLocal.setHours(0, 0, 0, 0);

    const time1Str = typeof time1 === 'string' ? time1 : '00:00';
    const time2Str = typeof time2 === 'string' ? time2 : '00:00';
    const [h1, m1] = time1Str.split(':').map(Number);
    const [h2, m2] = time2Str.split(':').map(Number);

    const startLocal = new Date(todayLocal);
    startLocal.setHours(h1, m1, 0, 0);
    const endLocal = new Date(todayLocal);
    endLocal.setHours(h2, m2, 0, 0);

    if (startLocal.getTime() >= endLocal.getTime()) { // overnight period
      endLocal.setDate(endLocal.getDate() + 1);
    }

    // If we are currently before the start time, and it's an overnight window,
    // we might be in the *previous* day's window.
    if (nowLocal.getTime() < startLocal.getTime() && (startLocal.getDate() !== endLocal.getDate())) {
      startLocal.setDate(startLocal.getDate() - 1);
      endLocal.setDate(endLocal.getDate() - 1);
    }

    // If we are already past the window for today, shift to tomorrow's window
    if (nowLocal.getTime() >= endLocal.getTime()) {
      startLocal.setDate(startLocal.getDate() + 1);
      endLocal.setDate(endLocal.getDate() + 1);
    }

    const startUTC = new Date(startLocal.getTime() - homeyOffset);
    const endUTC = new Date(endLocal.getTime() - homeyOffset);

    const priceObjects = PriceCalculator.selectPriceObjects(this.device.prices, startUTC, endUTC);
    const prices = priceObjects.map((p) => p.muPrice);

    const nowUTCms = now.getTime();
    const isNowInWindow = nowUTCms >= startUTC.getTime() && nowUTCms < endUTC.getTime();

    const currentIndex = isNowInWindow ? Math.floor((nowUTCms - startUTC.getTime()) / (this.device.priceInterval * 60 * 1000)) : -1;

    return { prices, isNowInWindow, currentIndex };
  }

  getDurationSteps(args) {
    if (args.periods !== undefined) return Math.max(1, Math.round(Number(args.periods)));
    if (args.duration !== undefined) return Math.max(1, Math.round(Number(args.duration)));
    if (args.hours !== undefined) return Math.max(1, Math.round(Number(args.hours) * this.stepsPerHour));
    return 1;
  }

  checkAvgRank(prices, durationSteps, currentIndex, type) {
    const safeSteps = Math.max(1, Math.round(Number.isFinite(Number(durationSteps)) ? Number(durationSteps) : 1));
    const avgPrices = [];
    prices.forEach((price, index) => {
      if (index > prices.length - safeSteps) return;
      const idxMin = index;
      const idxMax = index + safeSteps - 1;
      const slice = prices.slice(idxMin, idxMax + 1);
      const avgPrice = PriceCalculator.average(slice);
      avgPrices.push({ avgPrice, idxMin, idxMax });
    });
    if (avgPrices.length === 0) return false;
    avgPrices.sort((a, b) => (type === 'min' ? a.avgPrice - b.avgPrice : b.avgPrice - a.avgPrice));
    return (currentIndex >= avgPrices[0].idxMin) && (currentIndex <= avgPrices[0].idxMax);
  }

  // EXECUTORS FOR ACTION FLOWS
  async prices_json(args) {
    const { period } = args;
    this.device.log('Creating prices JSON via flow', this.device.getName(), period);
    let prices = this.device.state.pricesNextHours;
    if (period === 'tomorrow') prices = this.device.state.pricesTomorrow;
    if (period === 'this_day') prices = this.device.state.pricesThisDay;
    if (!prices) throw Error('No prices available');
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(roundedPrices);
    const provider = this.device.pricesProvider || 'Unknown';
    return { prices: priceString, provider };
  }

  async export_prices_json(args) {
    const { period } = args;
    this.device.log('Creating export prices JSON via flow', this.device.getName(), period);

    let prices;
    if (period === 'next_hours') {
      prices = this.device.state.exportPricesNextHours;
    } else {
      const periods = this.device.getUTCPeriods();
      const start = period === 'tomorrow' ? periods.tomorrowStart : periods.todayStart;
      const end = period === 'tomorrow' ? periods.tomorrowEnd : periods.tomorrowStart;
      prices = PriceCalculator.selectExportPrices(this.device.prices, start, end);
    }

    if (!prices || prices.length === 0) throw Error('No export prices available');
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(roundedPrices);
    const provider = this.device.pricesProvider || 'Unknown';
    return { prices: priceString, provider };
  }

  async set_variable_markup(args) {
    const val = args.value;
    this.device.log('changing variable markup via flow', this.device.getName(), val);
    await this.device.setSettings({ variableMarkup: val }).catch((err) => this.device.error(err));
    this.device.restartDevice(1000).catch((error) => this.device.error(error));
  }

  async set_fixed_markup(args) {
    const val = args.value;
    this.device.log('changing fixed markup via flow', this.device.getName(), val);
    await this.device.setSettings({ fixedMarkup: val }).catch((err) => this.device.error(err));
    this.device.restartDevice(1000).catch((error) => this.device.error(error));
  }

  async set_fixed_markup_TOD(args) {
    const val = args.value;
    this.device.log('changing Time Of Day markup via flow', this.device.getName(), val);
    const todObject = PriceCalculator.parseTOD(val); // will throw Error if invalid
    if (todObject === null) await this.device.setSettings({ fixedMarkupTOD: '' }).catch((err) => this.device.error(err));
    else await this.device.setSettings({ fixedMarkupTOD: val }).catch((err) => this.device.error(err));
    this.device.restartDevice(1000).catch((error) => this.device.error(error));
  }

  async set_fixed_markup_weekend(args) {
    const val = args.value;
    this.device.log('changing Weekend markup via flow', this.device.getName(), val);
    if (!Number.isFinite(val)) throw Error('Value is not a number');
    await this.device.setSettings({ fixedMarkupWeekend: val }).catch((err) => this.device.error(err));
    this.device.restartDevice(1000).catch((error) => this.device.error(error));
  }

  async set_exchange_rate(args) {
    const val = args.value;
    this.device.log('changing exchange rate via flow', this.device.getName(), val);
    await this.device.setSettings({ exchangeRate: val }).catch((err) => this.device.error(err));
    this.device.restartDevice(1000).catch((error) => this.device.error(error));
  }

  // EXECUTORS FOR CONDITION FLOWS
  async price_lowest(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    let minimum = Math.min(...this.device.state.pricesThisDay);
    // period acts as both string flag and numeric limit here
    const pArg = args.period ?? args.hours ?? 'this_day';
    if (pArg !== 'this_day' && Number.isFinite(Number(pArg))) {
      let limitSteps = Math.round(Number(pArg) * this.stepsPerHour);
      if (args.periods !== undefined) limitSteps = Math.round(Number(args.periods));
      minimum = Math.min(...this.device.state.pricesNext8h.slice(0, limitSteps));
    }
    return this.device.state.priceNow <= minimum;
  }

  async price_lowest_today(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const num = Math.max(1, Number(args.number) || 1);
    const lowestNPrices = [...this.device.state.pricesThisDay].sort((a, b) => a - b).slice(0, num);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const num = Math.max(1, Number(args.number) || 1);
    const lowestNPrices = data.prices.sort((a, b) => a - b).slice(0, num);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_avg_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(data.prices, durationSteps, data.relativeIndex, 'min');
  }

  async price_lowest_between(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const { prices, isNowInWindow } = this.getPricesInWindow(args);
    if (!prices || prices.length === 0 || !isNowInWindow) return false;

    const num = Math.max(1, Number(args.number) || 1);
    const lowestNPrices = [...prices].sort((a, b) => a - b).slice(0, num);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_highest_between(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const { prices, isNowInWindow } = this.getPricesInWindow(args);
    if (!prices || prices.length === 0 || !isNowInWindow) return false;

    const num = Math.max(1, Number(args.number) || 1);
    const highestNPrices = [...prices].sort((a, b) => b - a).slice(0, num);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_lowest_avg_between(args) {
    const { prices, isNowInWindow, currentIndex } = this.getPricesInWindow(args);
    if (!prices || prices.length === 0 || !isNowInWindow) return false;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(prices, durationSteps, currentIndex, 'min');
  }

  async price_highest_avg_between(args) {
    const { prices, isNowInWindow, currentIndex } = this.getPricesInWindow(args);
    if (!prices || prices.length === 0 || !isNowInWindow) return false;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(prices, durationSteps, currentIndex, 'max');
  }

  async price_lowest_next_hours(args) {
    if (!this.device.state || !this.device.state.pricesNextHours) throw Error('No prices available');

    let limitSteps = 99 * this.stepsPerHour;
    const pArg = args.period ?? args.hours;
    if (pArg !== undefined) limitSteps = Math.round(Number(pArg) * this.stepsPerHour);
    if (args.periods !== undefined) limitSteps = Math.round(Number(args.periods));

    const comingXhours = [...this.device.state.pricesNextHours].slice(0, limitSteps);
    const num = Math.max(1, Number(args.number) || 1);
    const lowestNPrices = comingXhours.sort((a, b) => a - b).slice(0, num);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.device.state.pricesThisDay] : [...this.device.state.pricesNext8h];
    const currentStep = Math.floor(this.device.state.Q0 / (this.device.priceInterval / 15));
    const currentStepIndex = (args.period === 'this_day') ? currentStep : 0;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(pricesTotalPeriod, durationSteps, currentStepIndex, 'min');
  }

  async price_highest(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    let maximum = Math.max(...this.device.state.pricesThisDay);
    // period acts as both string flag and numeric limit here
    const pArg = args.period ?? args.hours ?? 'this_day';
    if (pArg !== 'this_day' && Number.isFinite(Number(pArg))) {
      let limitSteps = Math.round(Number(pArg) * this.stepsPerHour);
      if (args.periods !== undefined) limitSteps = Math.round(Number(args.periods));
      maximum = Math.max(...this.device.state.pricesNext8h.slice(0, limitSteps));
    }
    return this.device.state.priceNow >= maximum;
  }

  async price_highest_today(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const num = Math.max(1, Number(args.number) || 1);
    const highestNPrices = [...this.device.state.pricesThisDay].sort((a, b) => a - b).reverse().slice(0, num);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_next_hours(args) {
    if (!this.device.state || !this.device.state.pricesNextHours) throw Error('No prices available');

    let limitSteps = 99 * this.stepsPerHour;
    const pArg = args.period ?? args.hours;
    if (pArg !== undefined) limitSteps = Math.round(Number(pArg) * this.stepsPerHour);
    if (args.periods !== undefined) limitSteps = Math.round(Number(args.periods));

    const comingXhours = [...this.device.state.pricesNextHours].slice(0, limitSteps);
    const num = Math.max(1, Number(args.number) || 1);
    const highestNPrices = comingXhours.sort((a, b) => a - b).reverse().slice(0, num);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const num = Math.max(1, Number(args.number) || 1);
    const highestNPrices = data.prices.sort((a, b) => a - b).reverse().slice(0, num);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.device.state.pricesThisDay] : [...this.device.state.pricesNext8h];
    const currentStep = Math.floor(this.device.state.Q0 / (this.device.priceInterval / 15));
    const currentStepIndex = (args.period === 'this_day') ? currentStep : 0;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(pricesTotalPeriod, durationSteps, currentStepIndex, 'max');
  }

  async price_highest_avg_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const durationSteps = this.getDurationSteps(args);
    return this.checkAvgRank(data.prices, durationSteps, data.relativeIndex, 'max');
  }

  async price_below_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const avg = this.device.state[args.period];
    if (typeof avg !== 'number' || avg === 0) return false;
    const percent = 100 * (1 - this.device.state.priceNow / avg);
    return percent >= Number(args.percent);
  }

  async price_above_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const avg = this.device.state[args.period];
    if (typeof avg !== 'number' || avg === 0) return false;
    const percent = 100 * (this.device.state.priceNow / avg - 1);
    return percent >= Number(args.percent);
  }

  async new_prices_received(args) {
    const { prices, period } = args;
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(roundedPrices);
    const provider = this.device.pricesProvider || 'Unknown';
    const tokens = { prices: priceString, provider };
    const state = { period };
    this.device.log(`${this.device.getName()} received new prices for ${period} from ${provider}`, roundedPrices);
    if (this.device.homey.app.trigger_new_prices) await this.device.homey.app.trigger_new_prices(this.device, tokens, state);
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
      this.device.log(`${this.device.getName()} different number of price periods for ${period}`);
      this.device.log('oldPrices:', oldPricesSelection);
      this.device.log('newPrices:', newPricesSelection);
      if (newPricesSelection.length < oldPricesSelection.length) return;
    }

    let expectedPeriods = 24 * this.stepsPerHour;
    if (period !== 'next_hours') {
      expectedPeriods = Math.round(((end - start) / 3600000) * this.stepsPerHour);
    }

    if (period !== 'next_hours' && newPricesSelection.length !== expectedPeriods) {
      this.device.log(`${this.device.getName()} received ${newPricesSelection.length} price periods for ${period}`);
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
      let prices = PriceCalculator.calculateMarkupPrices(newPricesSelection, this.device.settings, this.device.timeZone);
      prices = PriceCalculator.selectPrices(prices, start, end);
      await this.new_prices_received({ prices, period });
    }
  }
}

module.exports = DapFlows;
