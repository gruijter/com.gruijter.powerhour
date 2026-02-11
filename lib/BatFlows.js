/* eslint-disable camelcase */

'use strict';

const util = require('util');
const tradeStrategy = require('./strategies/TradeStrategy');
const roiStrategy = require('./strategies/RoiStrategy');

const setTimeoutPromise = util.promisify(setTimeout);

class BatFlows {
  constructor(device) {
    this.device = device;
  }

  // EXECUTORS FOR CONDITION FLOWS AND TRIGGERS
  // BASIC STRATEGY FLOW (HP2016/2019)
  async price_batt_best_trade(args) {
    await setTimeoutPromise(3000); // wait 3 seconds for new hourly prices to be taken in
    if (!this.device.pricesNextHours) throw Error('No prices available');
    const { chargePower } = this.device.getSettings(); // max power
    const { dischargePower } = this.device.getSettings(); // max power
    const options = {
      prices: this.device.pricesNextHours,
      minPriceDelta: args.minPriceDelta,
      soc: this.device.soc,
      batCapacity: this.device.getSettings().batCapacity,
      chargePower,
      dischargePower,
    };
    const strat = tradeStrategy.getStrategy(options);
    return strat === Number(args.strat);
  }

  // ADVANCED STRATEGY FLOW (HP2023)
  async find_roi_strategy(args) {
    try {
      if (!this.device.getSettings().roiEnable) return Promise.resolve(null);
      const currentSessionId = this.device.sessionId;
      this.device.log(`ROI strategy calculation started for ${this.device.getName()} minPriceDelta:`, args.minPriceDelta);
      if (this.device.getSettings().roiMinProfit !== args.minPriceDelta) this.device.setSettings({ roiMinProfit: args.minPriceDelta }).catch((err) => this.device.error(err));

      await setTimeoutPromise(3000); // wait 3 seconds for new hourly prices to be taken in

      if (this.device.sessionId !== currentSessionId) return Promise.resolve(null);
      if (!this.device.pricesNextHours) throw Error('No prices available');
      if (!this.device.priceInterval) throw Error('No price interval available');

      const settings = this.device.getSettings();
      const chargeSpeeds = [
        {
          power: settings.chargePower, // Watt. Max speed charging power in Watt (on AC side), loss is included
          eff: 1 - (settings.chargeLoss / 100), // efficiency when using Max speed charging
        },
        {
          power: settings.chargePowerEff, // Watt. Efficient charging power in Watt (on AC side), loss is included
          eff: 1 - (settings.chargeLossEff / 100), // efficiency when using Efficient charging
        },
        {
          power: settings.chargePower3, // Watt. Additional charging power in Watt (on AC side), loss is included
          eff: 1 - (settings.chargeLoss3 / 100), // efficiency when using additional charging
        },
      ].filter((speed) => speed.power);

      const dischargeSpeeds = [
        {
          power: settings.dischargePower, // Watt. Max speed discharging power in Watt (on AC side), loss is included
          eff: 1 - (settings.dischargeLoss / 100), // efficiency when using Max speed discharging
        },
        {
          power: settings.dischargePowerEff, // Watt. Efficient discharging power in Watt (on AC side), loss is included
          eff: 1 - (settings.dischargeLossEff / 100), // efficiency when using Efficient discharging
        },
        {
          power: settings.dischargePower3, // Watt. Additional discharging power in Watt (on AC side), loss is included
          eff: 1 - (settings.dischargeLoss3 / 100), // efficiency when using additional discharging
        },
      ].filter((speed) => speed.power);

      const now = new Date();
      const startMinute = now.getMinutes();
      const options = {
        prices: [...this.device.pricesNextHours],
        minPriceDelta: args.minPriceDelta,
        soc: this.device.soc,
        startMinute,
        batCapacity: this.device.getSettings().batCapacity,
        chargeSpeeds,
        dischargeSpeeds,
        priceInterval: this.device.priceInterval,
      };

      const stratOptsString = JSON.stringify(options);
      if (this.device.lastStratOptsString === stratOptsString) {
        this.device.log('Strategy is pulled from cache', this.device.getName());
        const tokens = { ...this.device.lastStratTokens };
        if (args.invert_power) tokens.power *= -1;
        return Promise.resolve(tokens);
      }

      const strat = roiStrategy.getStrategy(options);
      const tokens = {
        power: strat[0].power,
        duration: strat[0].duration,
        endSoC: strat[0].soc,
        scheme: JSON.stringify(strat),
      };

      this.device.lastStratOptsString = stratOptsString;
      this.device.lastStratTokens = { ...tokens };
      if (args.invert_power) tokens.power *= -1;
      return Promise.resolve(tokens);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // trigger ROI flow cards
  async triggerNewRoiStrategyFlow() {
    try {
      if (!this.device.getSettings().roiEnable) return Promise.resolve(null);
      const currentSessionId = this.device.sessionId;
      await setTimeoutPromise(5000 + Math.random() * 20000);
      if (this.device.sessionId !== currentSessionId) return Promise.resolve(null);
      // get all minPriceDelta as entered by user in trigger flows for this device
      const argValues = await this.device.homey.app.new_roi_strategy.getArgumentValues(this.device);
      const uniqueArgs = argValues.filter((a, idx) => argValues.findIndex((b) => b.minPriceDelta === argValues[idx].minPriceDelta && b.invert_power === argValues[idx].invert_power) === idx);
      uniqueArgs.forEach(async (args) => {
        const tokens = await this.find_roi_strategy(args).catch((err) => this.device.error(err));
        if (tokens) {
          const state = args;
          if (this.device.homey.app.trigger_new_roi_strategy) this.device.homey.app.trigger_new_roi_strategy(this.device, tokens, state);
          await this.reTriggerNewRoiStrategyFlow(tokens, args).catch((err) => this.device.error(err));
        }
      });
      await setTimeoutPromise(5000 + Math.random() * 20000);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // re-trigger ROI flow cards when duration ends
  async reTriggerNewRoiStrategyFlow(tokens, args) {
    try {
      const {
        duration, endSoC, scheme,
      } = tokens;
      let { power } = tokens;
      if (args.invert_power) power *= -1; // normalize power to internal standard

      if (duration === 0) return;
      const currentSessionId = this.device.sessionId;
      const now = new Date();
      const startMinute = now.getMinutes();
      const buffer = Math.max(2, Math.round(this.device.priceInterval / 12));
      if ((startMinute % this.device.priceInterval) + duration >= (this.device.priceInterval - buffer)) return; // do not retrigger if duration is crossing to next period
      if (power < 0 && endSoC <= 1) return; // do not retrigger when discharging to empty
      if (power > 0 && endSoC >= 99) return; // do not retrigger when charging to full
      // Retrigger after delay when partly charging or discharging
      this.device.log(`Stopping ROI in ${startMinute + duration} minutes`, this.device.getName());
      const delay = (startMinute + duration) * 60 * 1000;
      await setTimeoutPromise(delay).catch((err) => this.device.error(err));
      if (this.device.sessionId !== currentSessionId) return;
      const state = args;
      const newTokens = {
        power: 0, duration: 0, endSoC, scheme,
      };
      this.device.log('Stopping ROI', this.device.getName());
      if (this.device.homey.app.trigger_new_roi_strategy) this.device.homey.app.trigger_new_roi_strategy(this.device, newTokens, state);
    } catch (error) {
      this.device.error(error);
    }
  }

  async triggerXomFlow(strat, samples, x, smoothing, minLoad) {
    const targetPower = strat ? strat.target : 0;

    if (this.device.xomTargetPower === undefined || this.device.xomTargetPower === null) {
      this.device.xomTargetPower = targetPower;
    }

    // Smoothing
    const preSmooth = this.device.xomTargetPower;
    this.device.xomTargetPower = (targetPower / samples) + (this.device.xomTargetPower * ((samples - 1) / samples));
    console.log(`[BatFlows] ${this.device.getName()} Raw: ${Math.round(targetPower)}W | Smoothed: ${Math.round(this.device.xomTargetPower)}W (was ${Math.round(preSmooth)}W) | Samples: ${samples} | Smoothing: ${smoothing}%`);

    // Trigger twice to support both inverted and non-inverted flow cards
    // 1. Normal (Charging = Positive)
    let tokens = {
      power: Math.round(this.device.xomTargetPower),
      x,
      smoothing,
      minLoad,
    };
    let state = { invert_power: false };
    if (this.device.homey.app.trigger_xom_strategy) this.device.homey.app.trigger_xom_strategy(this.device, tokens, state);

    // 2. Inverted (Charging = Negative)
    tokens = {
      ...tokens,
      power: -tokens.power,
    };
    state = { invert_power: true };
    if (this.device.homey.app.trigger_xom_strategy) this.device.homey.app.trigger_xom_strategy(this.device, tokens, state);
  }
}

module.exports = BatFlows;
