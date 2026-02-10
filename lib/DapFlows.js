/* eslint-disable camelcase */

'use strict';

const PriceCalculator = require('./PriceCalculator');

class DapFlows {
  constructor(device) {
    this.device = device;
  }

  get stepsPerHour() {
    return 60 / this.device.priceInterval;
  }

  getPricesBefore(args) {
    const currentStep = Math.floor(this.device.state.Q0 / (this.device.priceInterval / 15));
    let endStep = args.time * this.stepsPerHour;
    const stepsPerDay = 24 * this.stepsPerHour;

    if (endStep < currentStep) endStep += stepsPerDay;
    let startStep = endStep - (args.period * this.stepsPerHour);

    if ((currentStep >= endStep) || (currentStep < startStep)) return null;

    let pricesPartYesterday = [];
    let offset = 0;
    if (startStep < 0) {
      pricesPartYesterday = this.device.state.pricesYesterday.slice(startStep);
      offset = pricesPartYesterday.length;
      startStep = 0;
    }
    let pricesPartTomorrow = [];
    if (endStep > stepsPerDay) pricesPartTomorrow = this.device.state.pricesTomorrow.slice(0, endStep - stepsPerDay);
    const pricesPartToday = this.device.state.pricesThisDay.slice(startStep, endStep);
    const prices = [...pricesPartYesterday, ...pricesPartToday, ...pricesPartTomorrow];

    const relativeIndex = currentStep + offset - startStep;
    return { prices, relativeIndex };
  }

  checkAvgRank(prices, hours, currentIndex, type) {
    const durationSteps = Number(hours) * this.stepsPerHour;
    const avgPrices = [];
    prices.forEach((price, index) => {
      if (index > prices.length - durationSteps) return;
      const idxMin = index;
      const idxMax = index + durationSteps - 1;
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
    const tokens = { prices: priceString };
    return tokens;
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
    if (args.period !== 'this_day') minimum = Math.min(...this.device.state.pricesNext8h.slice(0, Number(args.period) * this.stepsPerHour));
    return this.device.state.priceNow <= minimum;
  }

  async price_lowest_today(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const lowestNPrices = [...this.device.state.pricesThisDay].sort((a, b) => a - b).slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const lowestNPrices = data.prices.sort((a, b) => a - b).slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_avg_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    return this.checkAvgRank(data.prices, args.hours, data.relativeIndex, 'min');
  }

  async price_lowest_next_hours(args) {
    if (!this.device.state || !this.device.state.pricesNextHours) throw Error('No prices available');
    const period = args.period ? args.period : 99;
    const comingXhours = [...this.device.state.pricesNextHours].slice(0, period * this.stepsPerHour);
    const lowestNPrices = comingXhours.sort((a, b) => a - b).slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow <= Math.max(...lowestNPrices);
  }

  async price_lowest_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.device.state.pricesThisDay] : [...this.device.state.pricesNext8h];
    const currentStep = Math.floor(this.device.state.Q0 / (this.device.priceInterval / 15));
    const currentStepIndex = (args.period === 'this_day') ? currentStep : 0;
    return this.checkAvgRank(pricesTotalPeriod, args.hours, currentStepIndex, 'min');
  }

  async price_highest(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    let maximum = Math.max(...this.device.state.pricesThisDay);
    if (args.period !== 'this_day') maximum = Math.max(...this.device.state.pricesNext8h.slice(0, Number(args.period) * this.stepsPerHour));
    return this.device.state.priceNow >= maximum;
  }

  async price_highest_today(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const highestNPrices = [...this.device.state.pricesThisDay].sort((a, b) => a - b).reverse().slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_next_hours(args) {
    if (!this.device.state || !this.device.state.pricesNextHours) throw Error('No prices available');
    const comingXhours = [...this.device.state.pricesNextHours].slice(0, args.period * this.stepsPerHour);
    const highestNPrices = comingXhours.sort((a, b) => a - b).reverse().slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    const highestNPrices = data.prices.sort((a, b) => a - b).reverse().slice(0, args.number * this.stepsPerHour);
    return this.device.state.priceNow >= Math.min(...highestNPrices);
  }

  async price_highest_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const pricesTotalPeriod = (args.period === 'this_day') ? [...this.device.state.pricesThisDay] : [...this.device.state.pricesNext8h];
    const currentStep = Math.floor(this.device.state.Q0 / (this.device.priceInterval / 15));
    const currentStepIndex = (args.period === 'this_day') ? currentStep : 0;
    return this.checkAvgRank(pricesTotalPeriod, args.hours, currentStepIndex, 'max');
  }

  async price_highest_avg_before(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const data = this.getPricesBefore(args);
    if (!data) return false;
    return this.checkAvgRank(data.prices, args.hours, data.relativeIndex, 'max');
  }

  async price_below_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const percent = 100 * (1 - this.device.state.priceNow / this.device.state[args.period]);
    return percent >= Number(args.percent);
  }

  async price_above_avg(args) {
    if (!this.device.state || !this.device.state.pricesThisDay) throw Error('No prices available');
    const percent = 100 * (this.device.state.priceNow / this.device.state[args.period] - 1);
    return percent >= Number(args.percent);
  }

  async new_prices_received(args) {
    const { prices, period } = args;
    const roundedPrices = prices.map((price) => Math.round(price * 10000) / 10000);
    const priceString = JSON.stringify(roundedPrices);
    const tokens = { prices: priceString };
    const state = { period };
    this.device.log(`${this.device.getName()} received new prices for ${period}`, roundedPrices);
    if (this.device.homey.app.trigger_new_prices) this.device.homey.app.trigger_new_prices(this.device, tokens, state);
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

    if (period !== 'next_hours' && newPricesSelection.length !== 24) {
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
