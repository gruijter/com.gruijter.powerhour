/* eslint-disable global-require */
/*
Copyright 2019 - 2025, Robin de Gruijter (gruijter@hotmail.com)

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
const { HomeyAPI } = require('homey-api');

// require('inspector').open(9229, '0.0.0.0', false);

class MyApp extends Homey.App {

  async onInit() {
    try {
      // for debugging
      // if (process.env.DEBUG === '1') {
      //   try {
      //     require('inspector').waitForDebugger();
      //   }  catch (error) {
      //     require('inspector').open(9222, '0.0.0.0', true);
      //   }
      // }

      // login to Homey API
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });

      // start polling every whole hour, 15 minutes and retry missing source devices every 5 minutes
      this.homey.setMaxListeners(30); // INCREASE LISTENERS
      this.everyHour();
      this.everyXminutes(15);
      this.retry(5);

      // register flows
      this.registerFlowListeners();

      this.log('Power by the Hour app is running...');
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('app onUninit called');
    this.homey.removeAllListeners('everyhour_PBTH');
    this.homey.removeAllListeners('every15m_PBTH');
    this.homey.removeAllListeners('retry_PBTH');
    this.homey.removeAllListeners('set_tariff_power_PBTH');
    this.homey.removeAllListeners('set_tariff_gas_PBTH');
    this.homey.removeAllListeners('set_tariff_water_PBTH');
  }

  everyHour() {
    const scheduleNextHour = () => {
      if (this.everyHourId) this.homey.clearTimeout(this.everyHourId); // Clear any existing timeout
      const now = new Date();
      const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 50);
      const timeToNextHour = nextHour - now;
      // console.log('everyHour starts in', timeToNextHour / 1000);
      this.everyHourId = this.homey.setTimeout(() => {
        this.homey.emit('everyhour_PBTH', true);
        scheduleNextHour(); // Schedule the next hour
      }, timeToNextHour);
    };
    scheduleNextHour();
    this.log('everyHour job started');
  }

  everyXminutes(interval = 15) {
    const scheduleNextXminutes = () => {
      if (this.everyXMinutesId) this.homey.clearTimeout(this.everyXMinutesId); // Clear any existing timeout
      const now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 0);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      this.everyXMinutesId = this.homey.setTimeout(() => {
        // Only emit if not on a full hour
        if (now.getMinutes() !== 0) this.homey.emit('every15m_PBTH', true);
        scheduleNextXminutes(); // Schedule the next X minutes
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('every15m job started');
  }

  retry(interval = 5) {
    if (this.retryId) this.homey.clearTimeout(this.retryId);
    this.retryId = this.homey.setInterval(async () => {
      this.homey.emit('retry_PBTH', true);
    }, interval * 60 * 1000);
    this.log('retry job started');
  }

  registerFlowListeners() {
    const autoComplete = async (query, driverId) => {
      const driver = await this.homey.drivers.getDriver(driverId);
      const devices = await driver.getDevices()
        .filter((device) => device.settings.source_device_type === 'virtual via flow');
      const devicesMap = devices.map((device) => (
        {
          name: device.getName(),
          id: device.getData().id,
        }
      ));
      return devicesMap.filter((result) => result.name.toLowerCase().includes(query.toLowerCase()));
    };

    const runUpdateMeter = async (args, driverId) => {
      const driver = await this.homey.drivers.getDriver(driverId);
      const device = await driver.getDevice({ id: args.virtual_device.id });
      device.updateMeterFromFlow(args.value).catch(this.error);
    };

    // trigger cards
    this._priceLowest = this.homey.flow.getDeviceTriggerCard('price_lowest');
    this._priceLowest.registerRunListener(async (args) => args.device.priceIsLowest(args));
    this.triggerPriceLowest = (device, tokens, state) => {
      this._priceLowest
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceLowestToday = this.homey.flow.getDeviceTriggerCard('price_lowest_today');
    this._priceLowestToday.registerRunListener(async (args) => args.device.priceIsLowestToday(args));
    this.triggerPriceLowestToday = (device, tokens, state) => {
      this._priceLowestToday
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceLowestBefore = this.homey.flow.getDeviceTriggerCard('price_lowest_before');
    this._priceLowestBefore.registerRunListener(async (args) => args.device.priceIsLowestBefore(args));
    this.triggerPriceLowestBefore = (device, tokens, state) => {
      this._priceLowestBefore
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceLowestAvg = this.homey.flow.getDeviceTriggerCard('price_lowest_avg');
    this._priceLowestAvg.registerRunListener(async (args) => args.device.priceIsLowestAvg(args));
    this.triggerPriceLowestAvg = (device, tokens, state) => {
      this._priceLowestAvg
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceLowestAvgBefore = this.homey.flow.getDeviceTriggerCard('price_lowest_avg_before');
    this._priceLowestAvgBefore.registerRunListener(async (args) => args.device.priceIsLowestAvgBefore(args));
    this.triggerPriceLowestAvgBefore = (device, tokens, state) => {
      this._priceLowestAvgBefore
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceHighest = this.homey.flow.getDeviceTriggerCard('price_highest');
    this._priceHighest.registerRunListener(async (args) => args.device.priceIsHighest(args));
    this.triggerPriceHighest = (device, tokens, state) => {
      this._priceHighest
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceHighestToday = this.homey.flow.getDeviceTriggerCard('price_highest_today');
    this._priceHighestToday.registerRunListener(async (args) => args.device.priceIsHighestToday(args));
    this.triggerPriceHighestToday = (device, tokens, state) => {
      this._priceHighestToday
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceHighestBefore = this.homey.flow.getDeviceTriggerCard('price_highest_before');
    this._priceHighestBefore.registerRunListener(async (args) => args.device.priceIsHighestBefore(args));
    this.triggerPriceHighestBefore = (device, tokens, state) => {
      this._priceHighestBefore
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceHighestAvg = this.homey.flow.getDeviceTriggerCard('price_highest_avg');
    this._priceHighestAvg.registerRunListener(async (args) => args.device.priceIsHighestAvg(args));
    this.triggerPriceHighestAvg = (device, tokens, state) => {
      this._priceHighestAvg
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceHighestAvgBefore = this.homey.flow.getDeviceTriggerCard('price_highest_avg_before');
    this._priceHighestAvgBefore.registerRunListener(async (args) => args.device.priceIsHighestAvgBefore(args));
    this.triggerPriceHighestAvgBefore = (device, tokens, state) => {
      this._priceHighestAvgBefore
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceBelowAvg = this.homey.flow.getDeviceTriggerCard('price_below_avg');
    this._priceBelowAvg.registerRunListener(async (args) => args.device.priceIsBelowAvg(args));
    this.triggerPriceBelowAvg = (device, tokens, state) => {
      this._priceBelowAvg
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._priceAboveAvg = this.homey.flow.getDeviceTriggerCard('price_above_avg');
    this._priceAboveAvg.registerRunListener(async (args) => args.device.priceIsAboveAvg(args));
    this.triggerPriceAboveAvg = (device, tokens, state) => {
      this._priceAboveAvg
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._newPrices = this.homey.flow.getDeviceTriggerCard('new_prices');
    this._newPrices.registerRunListener(async (args, state) => args.period === state.period);
    this.newPrices = (device, tokens, state) => {
      this._newPrices
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens))
        .catch(this.error);
    };

    this._newRoiStrategy = this.homey.flow.getDeviceTriggerCard('new_roi_strategy');
    this._newRoiStrategy.registerRunListener(async (args, state) => args.minPriceDelta === state.minPriceDelta);
    this.triggerNewRoiStrategy = (device, tokens, state) => {
      this._newRoiStrategy
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens, state))
        .catch(this.error);
    };

    this._XOMStrategy = this.homey.flow.getDeviceTriggerCard('xom_strategy');
    this._XOMStrategy.registerRunListener(async (args, state) => state); // always run
    this.triggerXOMStrategy = (device, tokens, state) => {
      this._XOMStrategy
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens, state))
        .catch(this.error);
    };

    this._newHour = this.homey.flow.getDeviceTriggerCard('new_hour');
    this._newHour.registerRunListener(async (args, state) => state); // always run
    this.triggerNewHour = (device, tokens, state) => {
      this._newHour
        .trigger(device, tokens, state)
        // .then(this.log(device.getName(), tokens, state))
        .catch(this.error);
    };

    // condition cards
    const priceLowestCondition = this.homey.flow.getConditionCard('price_lowest');
    priceLowestCondition.registerRunListener((args) => args.device.priceIsLowest(args));

    const priceLowestTodayCondition = this.homey.flow.getConditionCard('price_lowest_today');
    priceLowestTodayCondition.registerRunListener((args) => args.device.priceIsLowestToday(args));

    const priceLowestNextHoursCondition = this.homey.flow.getConditionCard('price_lowest_next_hours');
    priceLowestNextHoursCondition.registerRunListener((args) => args.device.priceIsLowestNextHours(args));

    const priceLowestNextKnownHoursCondition = this.homey.flow.getConditionCard('price_lowest_next_known_hours');
    priceLowestNextKnownHoursCondition.registerRunListener((args) => args.device.priceIsLowestNextHours(args));

    const priceLowestBeforeCondition = this.homey.flow.getConditionCard('price_lowest_before');
    priceLowestBeforeCondition.registerRunListener((args) => args.device.priceIsLowestBefore(args));

    const priceLowestAvgBeforeCondition = this.homey.flow.getConditionCard('price_lowest_avg_before');
    priceLowestAvgBeforeCondition.registerRunListener((args) => args.device.priceIsLowestAvgBefore(args));

    const priceLowestAvgCondition = this.homey.flow.getConditionCard('price_lowest_avg');
    priceLowestAvgCondition.registerRunListener((args) => args.device.priceIsLowestAvg(args));

    const priceBelowAvgCondition = this.homey.flow.getConditionCard('price_below_avg');
    priceBelowAvgCondition.registerRunListener((args) => args.device.priceIsBelowAvg(args));

    const priceHighestCondition = this.homey.flow.getConditionCard('price_highest');
    priceHighestCondition.registerRunListener((args) => args.device.priceIsHighest(args));

    const priceHighestTodayCondition = this.homey.flow.getConditionCard('price_highest_today');
    priceHighestTodayCondition.registerRunListener((args) => args.device.priceIsHighestToday(args));

    const priceHighestNextHoursCondition = this.homey.flow.getConditionCard('price_highest_next_hours');
    priceHighestNextHoursCondition.registerRunListener((args) => args.device.priceIsHighestNextHours(args));

    const priceHighestBeforeCondition = this.homey.flow.getConditionCard('price_highest_before');
    priceHighestBeforeCondition.registerRunListener((args) => args.device.priceIsHighestBefore(args));

    const priceHighestAvgCondition = this.homey.flow.getConditionCard('price_highest_avg');
    priceHighestAvgCondition.registerRunListener((args) => args.device.priceIsHighestAvg(args));

    const priceHighestAvgBeforeCondition = this.homey.flow.getConditionCard('price_highest_avg_before');
    priceHighestAvgBeforeCondition.registerRunListener((args) => args.device.priceIsHighestAvgBefore(args));

    const priceAboveAvgCondition = this.homey.flow.getConditionCard('price_above_avg');
    priceAboveAvgCondition.registerRunListener((args) => args.device.priceIsAboveAvg(args));

    const priceBattBestTradeCondition = this.homey.flow.getConditionCard('price_batt_best_trade');
    priceBattBestTradeCondition.registerRunListener((args) => args.device.priceBattBestTrade(args));

    // action cards
    const setXOMsettings = this.homey.flow.getActionCard('set_xom_settings');
    setXOMsettings
      .registerRunListener(async (args) => {
        this.log('XOM settings set by flow:', args);
        this.homey.settings.set('xomSettings', args);
      });

    const setTariffPower = this.homey.flow.getActionCard('set_tariff_power');
    setTariffPower
      .registerRunListener((args) => this.homey.emit('set_tariff_power_PBTH', args));

    const setTariffGas = this.homey.flow.getActionCard('set_tariff_gas');
    setTariffGas
      .registerRunListener((args) => this.homey.emit('set_tariff_gas_PBTH', args));

    const setTariffWater = this.homey.flow.getActionCard('set_tariff_water');
    setTariffWater
      .registerRunListener((args) => this.homey.emit('set_tariff_water_PBTH', args));

    const setTariffGroup = this.homey.flow.getActionCard('set_tariff_group');
    setTariffGroup
      .registerRunListener((args) => args.device.setTariffGroup(args.group).catch(this.error));

    const setVariableMarkup = this.homey.flow.getActionCard('set_variable_markup');
    setVariableMarkup
      .registerRunListener((args) => args.device.setVariableMarkup(args.value).catch(this.error));

    const setFixedMarkup = this.homey.flow.getActionCard('set_fixed_markup');
    setFixedMarkup
      .registerRunListener((args) => args.device.setFixedMarkup(args.value).catch(this.error));

    const setFixedMarkupTOD = this.homey.flow.getActionCard('set_fixed_markup_TOD');
    setFixedMarkupTOD
      .registerRunListener((args) => args.device.setFixedMarkupTOD(args.value));

    const setFixedMarkupWeekend = this.homey.flow.getActionCard('set_fixed_markup_weekend');
    setFixedMarkupWeekend
      .registerRunListener((args) => args.device.setFixedMarkupWeekend(args.value));

    const setDailyFixedCost = this.homey.flow.getActionCard('set_daily_fixed_cost');
    setDailyFixedCost
      .registerRunListener((args) => args.device.setDailyFixedCost(args.value).catch(this.error));

    const setExchangeRate = this.homey.flow.getActionCard('set_exchange_rate');
    setExchangeRate
      .registerRunListener((args) => args.device.setExchangeRate(args.value).catch(this.error));

    const minMaxReset = this.homey.flow.getActionCard('minmax_reset');
    minMaxReset
      .registerRunListener((args) => args.device.minMaxReset(true, 'flow').catch(this.error));

    const pricesJSON = this.homey.flow.getActionCard('prices_json');
    pricesJSON
      .registerRunListener((args) => args.device.createPricesJSON(args.period));

    const findRoiStrategy = this.homey.flow.getActionCard('find_roi_strategy');
    findRoiStrategy
      .registerRunListener((args) => args.device.findRoiStrategy(args, 'flow').catch(this.error));

    const setMeterPower = this.homey.flow.getActionCard('set_meter_power');
    setMeterPower
      .registerRunListener((args) => runUpdateMeter(args, 'power').catch(this.error))
      .registerArgumentAutocompleteListener(
        'virtual_device',
        (query) => autoComplete(query, 'power').catch(this.error),
      );
    const setMeterGas = this.homey.flow.getActionCard('set_meter_gas');
    setMeterGas
      .registerRunListener((args) => runUpdateMeter(args, 'gas').catch(this.error))
      .registerArgumentAutocompleteListener(
        'virtual_device',
        async (query) => autoComplete(query, 'gas').catch(this.error),
      );

    const setMeterWater = this.homey.flow.getActionCard('set_meter_water');
    setMeterWater
      .registerRunListener((args) => runUpdateMeter(args, 'water').catch(this.error))
      .registerArgumentAutocompleteListener(
        'virtual_device',
        async (query) => autoComplete(query, 'water').catch(this.error),
      );
  }

}

module.exports = MyApp;
