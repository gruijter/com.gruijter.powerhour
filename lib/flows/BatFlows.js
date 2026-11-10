/* eslint-disable camelcase */

'use strict';

const tradeStrategy = require('../strategies/TradeStrategy');
const BatteryPlan = require('../helpers/BatteryPlan');
const { setTimeoutPromise } = require('../helpers/Util');
const TimeHelpers = require('../helpers/TimeHelpers');

class BatFlows {
  constructor(device) {
    this.device = device;
  }

  async set_tariff_group(args) {
    const { group } = args;
    this.device.log('changing tariff update group via flow', this.device.getName(), group);
    await this.device.setSettings({ tariff_update_group: group }).catch((err) => this.device.error(err));
    this.device.tariffGroupChanged = true; // setSettings() skips onSettings() (SDK Device.d.ts): the new group's prices after the restart
    this.device.restartDevice(60 * 1000).catch((error) => this.device.error(error));
  }

  async set_battery_mode(args) {
    const minutes = Math.max(0, Math.round(Number(args.duration) || 0));
    await this.device.setBatteryMode(args.mode, 'flow', minutes);
    return true;
  }

  async calibrate_battery(args) {
    if (args.action === 'stop') await this.device.stopCalibration('flow');
    else await this.device.requestCalibration();
    return true;
  }

  async battery_mode_is(args) {
    return this.device.getBatteryMode() === args.mode;
  }

  async price_batt_best_trade(args) {
    await setTimeoutPromise(3000, this.device); // wait 3 seconds for new hourly prices to be taken in
    if (!this.device.pricesNextHours) throw Error(this.device.homey.__('error_no_prices'));
    const { chargePower } = this.device.getSettings();
    const { dischargePower } = this.device.getSettings();
    const { prices, exportPrices } = this.device.pricesFromNow();
    const options = {
      prices,
      exportPrices: exportPrices || null,
      priceInterval: this.device.priceInterval || 60,
      minPriceDelta: args.minPriceDelta,
      soc: this.device.soc,
      batCapacity: this.device.capacityKwh(),
      chargePower,
      dischargePower,
    };
    const strat = tradeStrategy.getStrategy(options);
    return strat === Number(args.strat);
  }

  // The plan of the device settings (minimum profit, wear cost): the plan of the chart and the
  // built-in control.
  async get_battery_plan_power(args) {
    return this.planTokens({ minPriceDelta: this.device.getSettings().minProfit, invert_power: args.invert_power });
  }

  async set_battery_cost(args) {
    const value = Number(args.value);
    if (args.value === null || args.value === '' || !Number.isFinite(value) || value < 0) {
      throw Error(this.device.homey.__('error_value_not_number'));
    }
    const key = args.cost === 'wear' ? 'wearCost' : 'minProfit';
    if (this.device.getSettings()[key] === value) return true;
    this.device.log(`${key} set by flow`, this.device.getName(), value);
    await this.device.setSettings({ [key]: value });
    this.device.replanGroup('cost by flow').catch((err) => this.device.error(err));
    return true;
  }

  // Deprecated cards (find_roi_strategy, new_roi_strategy): their minimum profit is the setting, as
  // before, so the chart and built-in control follow these flows.
  async syncMinProfit(minPriceDelta) {
    if (!Number.isFinite(minPriceDelta) || this.device.getSettings().minProfit === minPriceDelta) return;
    await this.device.setSettings({ minProfit: minPriceDelta }).catch((err) => this.device.error(err));
  }

  async find_roi_strategy(args) {
    await this.syncMinProfit(args.minPriceDelta);
    return this.planTokens(args);
  }

  // The plan of this battery as flow tokens (lib/helpers/BatteryPlan.js).
  async planTokens(args, wait = true) {
    return BatteryPlan.tokens(this.device, args, wait);
  }

  // quick (a mode change): no wait for new prices, no spread after the slot boundary.
  async triggerNewPlanFlow({ quick = false } = {}) {
    try {
      const { app } = this.device.homey;
      // Deprecated card: a plan per minimum profit entered in its flows for this device.
      const argValues = await app.new_roi_strategy.getArgumentValues(this.device);
      const uniqueArgs = argValues.filter((a, idx) => argValues.findIndex((b) => b.minPriceDelta === argValues[idx].minPriceDelta && b.invert_power === argValues[idx].invert_power) === idx);
      for (const args of uniqueArgs) {
        await this.syncMinProfit(args.minPriceDelta);
        const tokens = await this.planTokens(args, !quick).catch((err) => this.device.error(err));
        if (tokens) {
          const fire = (t) => (app.trigger_new_roi_strategy ? app.trigger_new_roi_strategy(this.device, t, args) : null);
          await fire(tokens);
          this.reTriggerNewPlanFlow(tokens, args, fire, `roi|${args.minPriceDelta}|${!!args.invert_power}`)
            .catch((err) => this.device.error(err));
        }
      }
      await this.triggerPlanPowerFlow(!uniqueArgs.length && !quick);
      if (!quick) await setTimeoutPromise(5000 + Math.random() * 20000, this.device);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // The plan of the device settings, inverted and not (the run listener picks).
  async triggerPlanPowerFlow(wait = true) {
    const { app } = this.device.homey;
    if (!app.trigger_battery_plan_power) return;
    const argValues = await app.battery_plan_power.getArgumentValues(this.device);
    if (!argValues.length) return;
    const tokens = await this.planTokens({ minPriceDelta: this.device.getSettings().minProfit }, wait)
      .catch((err) => this.device.error(err));
    if (!tokens) return;
    const fire = (t) => Promise.all([false, true].map((invert) => app.trigger_battery_plan_power(this.device,
      { ...t, power: invert && t.power ? -t.power : t.power }, { invert_power: invert })));
    await fire(tokens);
    this.reTriggerNewPlanFlow(tokens, {}, fire, 'plan').catch((err) => this.device.error(err));
  }

  // re-trigger plan flow cards when duration ends; fire(tokens) triggers the card. key: the card (and
  // its args): a newer plan for it cancels the pending stop.
  async reTriggerNewPlanFlow(tokens, args, fire, key) {
    try {
      if (!this.retriggerSeq) this.retriggerSeq = {};
      const seq = (this.retriggerSeq[key] || 0) + 1;
      this.retriggerSeq[key] = seq;
      const {
        duration, endSoC, scheme,
      } = tokens;
      let { power } = tokens;
      if (args.invert_power) power *= -1; // normalize power to internal standard

      if (duration === 0) return;
      const currentSessionId = this.device.sessionId;
      // Local minute: plan slots follow local time, which differs from UTC minutes in
      // half-hour-offset zones (e.g. India, Adelaide).
      const startMinute = TimeHelpers.toLocalDate(new Date(), this.device.timeZone).getMinutes();
      const slotMin = this.device.planIntervalMin ? this.device.planIntervalMin() : this.device.priceInterval;
      const buffer = Math.max(2, Math.round(slotMin / 12));
      if ((startMinute % slotMin) + duration >= (slotMin - buffer)) return; // do not retrigger if duration is crossing to next slot
      if (power < 0 && endSoC <= 1) return; // do not retrigger when discharging to empty
      if (power > 0 && endSoC >= 99) return; // do not retrigger when charging to full
      // Retrigger after delay when partly charging or discharging
      this.device.log(`[Plan] Stopping in ${duration} minutes`, this.device.getName());
      const delay = duration * 60 * 1000;
      await setTimeoutPromise(delay, this.device).catch((err) => this.device.error(err));
      if (this.device.sessionId !== currentSessionId || this.retriggerSeq[key] !== seq) return;
      const newTokens = {
        power: 0, duration: 0, endSoC, scheme, block: 'idle',
      };
      this.device.log('[Plan] Stopping', this.device.getName());
      await fire(newTokens);
    } catch (error) {
      this.device.error(error);
    }
  }

  async triggerXomFlow(split, samples, x, smoothing, minLoad, cumulativePower) {
    const targetPower = split ? split.target : 0;

    if (this.device.xomTargetPower === undefined || this.device.xomTargetPower === null) {
      this.device.xomTargetPower = targetPower;
    }

    const effectiveSamples = (targetPower === 0) ? 1 : samples;
    this.device.xomTargetPower = (targetPower / effectiveSamples) + (this.device.xomTargetPower * ((effectiveSamples - 1) / effectiveSamples));

    // Trigger twice to support both inverted and non-inverted flow cards
    // 1. Normal (Charging = Positive)
    let tokens = {
      power: Math.round(this.device.xomTargetPower),
      x,
      smoothing,
      minLoad,
    };
    let state = { invert_power: false };
    if (this.device.homey.app.trigger_xom_strategy) await this.device.homey.app.trigger_xom_strategy(this.device, tokens, state);

    // 2. Inverted (Charging = Negative)
    tokens = {
      ...tokens,
      power: -tokens.power,
    };
    state = { invert_power: true };
    if (this.device.homey.app.trigger_xom_strategy) await this.device.homey.app.trigger_xom_strategy(this.device, tokens, state);
  }
}

module.exports = BatFlows;
