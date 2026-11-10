/* eslint-disable camelcase */

'use strict';

const tradeStrategy = require('../strategies/TradeStrategy');
const lightPlanner = require('../strategies/LightPlanner');
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

  // The LP (setting precisePlanning) or the light planner. wait: for new prices to be taken in.
  async planTokens(args, wait = true) {
    try {
      const currentSessionId = this.device.sessionId;
      this.device.log(`[Plan] Requested for ${this.device.getName()} minPriceDelta:`, args.minPriceDelta);

      if (wait) await setTimeoutPromise(3000, this.device); // wait 3 seconds for new hourly prices to be taken in

      if (this.device.sessionId !== currentSessionId) return Promise.resolve(null);
      if (!this.device.pricesNextHours) throw Error(this.device.homey.__('error_no_prices'));
      if (!this.device.priceInterval) throw Error(this.device.homey.__('error_no_price_interval'));

      const input = this.planInput(args.minPriceDelta);
      if (this.device.lastPlanKey === input.key) {
        this.device.log('[Plan] From cache', this.device.getName());
        const tokens = { ...this.device.lastPlanTokens };
        if (args.invert_power) tokens.power *= -1;
        return Promise.resolve(tokens);
      }
      const plan = input.solve();
      const options = { priceInterval: input.priceInterval };

      let continuousDuration = plan[0] ? plan[0].duration : 0;
      let finalEndSoC = plan[0] ? plan[0].soc : this.device.soc;
      const firstPower = plan[0] ? plan[0].power : 0;
      const firstBlock = (plan[0] && plan[0].block) || 'idle';

      if (firstPower !== 0 && continuousDuration > 0) {
        const keys = Object.keys(plan).map(Number).sort((a, b) => a - b);
        for (let i = 1; i < keys.length; i += 1) {
          const next = plan[keys[i]];
          if (!next || next.power !== firstPower || (next.block || 'idle') !== firstBlock) break;

          continuousDuration += next.duration;
          finalEndSoC = next.soc;

          if (next.duration < options.priceInterval) break;
        }
      }

      const tokens = {
        power: firstPower,
        duration: continuousDuration,
        endSoC: finalEndSoC,
        scheme: JSON.stringify(plan),
        block: firstBlock,
      };

      this.device.lastPlanKey = input.key;
      this.device.lastPlanTokens = { ...tokens };
      this.device.lastPlanTm = Date.now();
      this.device.lastPlanMinPriceDelta = args.minPriceDelta;
      if (args.invert_power) tokens.power *= -1;
      return Promise.resolve(tokens);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // The plan input of this battery, and how to get its plan. Batteries this app controls in
  // one mode are planned together (one LP, each with its own SoC, capacity, power and efficiency):
  // the first of the group solves, each takes its own plan.
  planInput(minPriceDelta) {
    const group = this.device.planGroup ? this.device.planGroup() : null;
    if (!group) {
      const options = this.device.buildPlanOptions(minPriceDelta);
      return {
        key: JSON.stringify(options),
        priceInterval: options.priceInterval,
        solve: () => BatFlows.solve(this.device, options, ''),
      };
    }
    // Each flow card's minPriceDelta gets its own group plan. The options are built once per plan
    // slot for all members and cards: the members plan up to ~25 s apart (random delay in
    // triggerNewPlanFlow()).
    const leader = group[0];
    const index = group.indexOf(this.device);
    const slotMs = TimeHelpers.startOfLocalBlock(Date.now(), leader.planIntervalMin(), leader.timeZone || leader.homey.clock.getTimezone());
    // initTm: a member's (re)init, e.g. after a settings change.
    const memoKey = JSON.stringify([group.map((d) => [d.getData().id, d.soc, d.getBatteryMode(), d.initTm]),
      leader.pricesUpdatedTm, slotMs]);
    if (!leader.groupPlans) leader.groupPlans = new Map();
    let entry = leader.groupPlans.get(minPriceDelta);
    if (!entry || entry.memoKey !== memoKey) {
      // At the start a member can get its prices before the leader: the prices are of the group.
      const source = leader.pricesNextHours ? leader : this.device;
      const options = source.buildPlanOptions(minPriceDelta, group);
      const key = JSON.stringify(options);
      entry = {
        memoKey, options, key, plans: entry && entry.key === key ? entry.plans : null,
      };
      leader.groupPlans.set(minPriceDelta, entry);
    }
    return {
      key: `${index}|${entry.key}`,
      priceInterval: entry.options.priceInterval,
      solve: () => {
        if (!entry.plans) entry.plans = BatFlows.solve(leader, entry.options, group);
        return entry.plans[index];
      },
    };
  }

  // The LP (setting precisePlanning, more memory and CPU) or the light planner. The LP is
  // loaded only when used.
  static planner(advanced) {
    // eslint-disable-next-line global-require
    return advanced ? require('../strategies/PrecisePlanner') : lightPlanner;
  }

  // group: the batteries of options.batteries, in that order; then a plan per battery.
  static solve(device, options, group = null) {
    const planStart = Date.now();
    const advanced = !!device.getSettings().precisePlanning;
    const planner = BatFlows.planner(advanced);
    let plan;
    if (options.idle) plan = lightPlanner.idlePlan(options);
    else plan = group ? planner.planEach(options) : planner.plan(options);
    // The planner saw each battery above its reserve: SoC back to the battery's.
    (group || [device]).forEach((d, i) => {
      if (typeof d.planSocToReal !== 'function') return;
      Object.values(group ? plan[i] : plan).forEach((slot) => {
        slot.soc = d.planSocToReal(slot.soc);
      });
    });
    const letters = (s) => Object.values(s).map((slot) => (slot.block || '-')[0]).join('');
    const blocks = group ? group.map((d, i) => `${d.getName()}: ${letters(plan[i])}`).join(' | ') : letters(plan);
    device.log(`[Plan] ${options.idle ? 'idle' : (advanced && 'LP') || 'light'}, ${group ? `group of ${group.length}, ` : ''}`
      + `${options.net ? 'grid forecast' : `fixed ${options.homePowerUsage} W`}, `
      + `${Object.keys(group ? plan[0] : plan).length} x ${options.priceInterval} min, ${Date.now() - planStart} ms: ${blocks}`);
    return plan;
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
