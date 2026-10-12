/* eslint-disable camelcase */

'use strict';

const tradeStrategy = require('../strategies/TradeStrategy');
const roiLightStrategy = require('../strategies/RoiLightStrategy');
const { setTimeoutPromise } = require('../helpers/Util');
const TimeHelpers = require('../helpers/TimeHelpers');

class BatFlows {
  constructor(device) {
    this.device = device;
  }

  // EXECUTORS FOR CONDITION FLOWS AND TRIGGERS
  async set_tariff_group(args) {
    const { group } = args;
    this.device.log('changing tariff update group via flow', this.device.getName(), group);
    await this.device.setSettings({ tariff_update_group: group }).catch((err) => this.device.error(err));
    this.device.restartDevice(60 * 1000).catch((error) => this.device.error(error));
  }

  async set_battery_mode(args) {
    const minutes = Math.max(0, Math.round(Number(args.duration) || 0));
    await this.device.setBatteryMode(args.mode, 'flow', minutes);
    return true;
  }

  async battery_mode_is(args) {
    return this.device.getBatteryMode() === args.mode;
  }

  // BASIC STRATEGY FLOW (HP2016/2019)
  async price_batt_best_trade(args) {
    await setTimeoutPromise(3000, this.device); // wait 3 seconds for new hourly prices to be taken in
    if (!this.device.pricesNextHours) throw Error('No prices available');
    const { chargePower } = this.device.getSettings(); // max power
    const { dischargePower } = this.device.getSettings(); // max power
    const { prices, exportPrices } = this.device.pricesFromNow();
    const options = {
      prices,
      exportPrices: exportPrices || null,
      priceInterval: this.device.priceInterval || 60,
      minPriceDelta: args.minPriceDelta,
      soc: this.device.soc,
      batCapacity: this.device.getSettings().batCapacity,
      chargePower,
      dischargePower,
    };
    const strat = tradeStrategy.getStrategy(options);
    return strat === Number(args.strat);
  }

  // STRATEGY FLOW: the LP (setting roiEnable) or the light planner
  async find_roi_strategy(args) {
    try {
      const currentSessionId = this.device.sessionId;
      this.device.log(`ROI strategy calculation started for ${this.device.getName()} minPriceDelta:`, args.minPriceDelta);
      if (this.device.getSettings().roiMinProfit !== args.minPriceDelta) this.device.setSettings({ roiMinProfit: args.minPriceDelta }).catch((err) => this.device.error(err));

      await setTimeoutPromise(3000, this.device); // wait 3 seconds for new hourly prices to be taken in

      if (this.device.sessionId !== currentSessionId) return Promise.resolve(null);
      if (!this.device.pricesNextHours) throw Error('No prices available');
      if (!this.device.priceInterval) throw Error('No price interval available');

      const plan = this.planInput(args.minPriceDelta);
      if (this.device.lastStratOptsString === plan.key) {
        this.device.log('Strategy is pulled from cache', this.device.getName());
        const tokens = { ...this.device.lastStratTokens };
        if (args.invert_power) tokens.power *= -1;
        return Promise.resolve(tokens);
      }
      const strat = plan.strategy();
      const stratOptsString = plan.key;
      const options = { priceInterval: plan.priceInterval };

      let continuousDuration = strat[0] ? strat[0].duration : 0;
      let finalEndSoC = strat[0] ? strat[0].soc : this.device.soc;
      const firstPower = strat[0] ? strat[0].power : 0;
      const firstBlock = (strat[0] && strat[0].block) || 'idle';

      if (firstPower !== 0 && continuousDuration > 0) {
        const stratKeys = Object.keys(strat).map(Number).sort((a, b) => a - b);
        for (let i = 1; i < stratKeys.length; i += 1) {
          const nextStrat = strat[stratKeys[i]];
          if (!nextStrat || nextStrat.power !== firstPower || (nextStrat.block || 'idle') !== firstBlock) break;

          continuousDuration += nextStrat.duration;
          finalEndSoC = nextStrat.soc;

          if (nextStrat.duration < options.priceInterval) break;
        }
      }

      const tokens = {
        power: firstPower,
        duration: continuousDuration,
        endSoC: finalEndSoC,
        scheme: JSON.stringify(strat),
        block: firstBlock,
      };

      this.device.lastStratOptsString = stratOptsString;
      this.device.lastStratTokens = { ...tokens };
      this.device.lastStratTm = Date.now();
      this.device.lastStratMinPriceDelta = args.minPriceDelta;
      if (args.invert_power) tokens.power *= -1;
      return Promise.resolve(tokens);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // The plan input of this battery, and how to get its strategy. Batteries this app controls in
  // one mode are planned together (one LP, each with its own SoC, capacity, power and efficiency):
  // the first of the group solves, each takes its own strategy.
  planInput(minPriceDelta) {
    const group = this.device.planGroup ? this.device.planGroup() : null;
    if (!group) {
      const options = this.device.buildRoiOptions(minPriceDelta);
      return {
        key: JSON.stringify(options),
        priceInterval: options.priceInterval,
        strategy: () => BatFlows.solve(this.device, options, ''),
      };
    }
    const leader = group[0];
    const options = leader.buildRoiOptions(leader.getSettings().roiMinProfit, group);
    const groupKey = JSON.stringify(options);
    const index = group.indexOf(this.device);
    return {
      key: JSON.stringify({ groupKey, index }),
      priceInterval: options.priceInterval,
      strategy: () => {
        if (leader.groupStratKey !== groupKey) {
          leader.groupStrat = BatFlows.solve(leader, options, group);
          leader.groupStratKey = groupKey;
        }
        return leader.groupStrat[index];
      },
    };
  }

  // The LP (setting roiEnable: "advanced", more memory and CPU) or the light planner. The LP is
  // loaded only when used.
  static planner(advanced) {
    // eslint-disable-next-line global-require
    return advanced ? require('../strategies/RoiStrategy') : roiLightStrategy;
  }

  // group: the batteries of options.batteries, in that order; then a strategy per battery.
  static solve(device, options, group = null) {
    const planStart = Date.now();
    const advanced = !!device.getSettings().roiEnable;
    const planner = BatFlows.planner(advanced);
    const strat = group ? planner.getGroupStrategy(options) : planner.getStrategy(options);
    const letters = (s) => Object.values(s).map((slot) => (slot.block || '-')[0]).join('');
    const blocks = group ? group.map((d, i) => `${d.getName()}: ${letters(strat[i])}`).join(' | ') : letters(strat);
    device.log(`[ROI Plan] ${advanced ? 'LP' : 'light'}, ${group ? `group of ${group.length}, ` : ''}`
      + `${options.net ? 'grid forecast' : `fixed ${options.homePowerUsage} W`}, `
      + `${Object.keys(group ? strat[0] : strat).length} x ${options.priceInterval} min, ${Date.now() - planStart} ms: ${blocks}`);
    return strat;
  }

  async triggerNewRoiStrategyFlow() {
    try {
      // get all minPriceDelta as entered by user in trigger flows for this device
      const argValues = await this.device.homey.app.new_roi_strategy.getArgumentValues(this.device);
      const uniqueArgs = argValues.filter((a, idx) => argValues.findIndex((b) => b.minPriceDelta === argValues[idx].minPriceDelta && b.invert_power === argValues[idx].invert_power) === idx);
      for (const args of uniqueArgs) {
        const tokens = await this.find_roi_strategy(args).catch((err) => this.device.error(err));
        if (tokens) {
          const state = args;
          if (this.device.homey.app.trigger_new_roi_strategy) await this.device.homey.app.trigger_new_roi_strategy(this.device, tokens, state);
          this.reTriggerNewRoiStrategyFlow(tokens, args).catch((err) => this.device.error(err));
        }
      }
      await setTimeoutPromise(5000 + Math.random() * 20000, this.device);
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
      // Local minute: plan slots follow local time, which differs from UTC minutes in
      // half-hour-offset zones (e.g. India, Adelaide).
      const startMinute = TimeHelpers.toLocalDate(new Date(), this.device.timeZone).getMinutes();
      const slotMin = this.device.planIntervalMin ? this.device.planIntervalMin() : this.device.priceInterval;
      const buffer = Math.max(2, Math.round(slotMin / 12));
      if ((startMinute % slotMin) + duration >= (slotMin - buffer)) return; // do not retrigger if duration is crossing to next slot
      if (power < 0 && endSoC <= 1) return; // do not retrigger when discharging to empty
      if (power > 0 && endSoC >= 99) return; // do not retrigger when charging to full
      // Retrigger after delay when partly charging or discharging
      this.device.log(`Stopping ROI in ${duration} minutes`, this.device.getName());
      const delay = duration * 60 * 1000;
      await setTimeoutPromise(delay, this.device).catch((err) => this.device.error(err));
      if (this.device.sessionId !== currentSessionId) return;
      const state = args;
      const newTokens = {
        power: 0, duration: 0, endSoC, scheme, block: 'idle',
      };
      this.device.log('Stopping ROI', this.device.getName());
      if (this.device.homey.app.trigger_new_roi_strategy) await this.device.homey.app.trigger_new_roi_strategy(this.device, newTokens, state);
    } catch (error) {
      this.device.error(error);
    }
  }

  async triggerXomFlow(strat, samples, x, smoothing, minLoad, cumulativePower) {
    const targetPower = strat ? strat.target : 0;

    if (this.device.xomTargetPower === undefined || this.device.xomTargetPower === null) {
      this.device.xomTargetPower = targetPower;
    }

    // Smoothing
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
