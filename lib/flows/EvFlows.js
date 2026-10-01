/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const BatFlows = require('./BatFlows');
const EvPlanner = require('../strategies/EvPlanner');

class EvFlows extends BatFlows {
  async triggerNewEvStrategyFlow(strategy) {
    if (!strategy || Object.keys(strategy).length === 0) return;

    const currentStrategy = strategy[0] || { power: 0, duration: 0 };
    let currentSoc = 0;
    if (this.device.sourceDevice && this.device.sourceDevice.capabilitiesObj && this.device.sourceDevice.capabilitiesObj.measure_battery) {
      currentSoc = this.device.sourceDevice.capabilitiesObj.measure_battery.value || 0;
    }

    const tokens = {
      power: currentStrategy.power || 0,
      duration: currentStrategy.duration || 0,
      targetSoC: currentStrategy.soc !== undefined ? currentStrategy.soc : currentSoc,
      scheme: JSON.stringify(strategy),
    };

    if (this.device.homey.app.trigger_new_ev_strategy) {
      await this.device.homey.app.trigger_new_ev_strategy(this.device, tokens, {}).catch((err) => this.device.error('Error triggering new_ev_strategy', err));
    }
  }

  async set_ev_soc(args) {
    if (typeof args.soc === 'number') {
      this.device.log(`Manual EV SoC set to ${args.soc}% via flow`);
      await this.device.setManualSoc(args.soc);
    }
    return true;
  }

  async set_ev_charge_mode(args) {
    if (!args.mode) throw new Error('Missing charge mode');
    await this.device.setChargeMode(args.mode, 'flow');
    return true;
  }

  // Tomorrow's departure at another time (HH:MM, may come from a tag), once.
  async set_ev_tomorrow_departure(args) {
    const time = EvPlanner.parseTime(args.time);
    if (!time) throw Error(this.device.homey.__('error_invalid_time', { time: args.time }));
    this.device.log(`[EV Plan] Departure tomorrow set to ${time} via flow`);
    await this.device.setTomorrowDeparture(time);
    return true;
  }

  async set_ev_tomorrow_time(args) {
    this.device.log(`[EV Plan] Departure tomorrow set to ${args.time} via flow`);
    await this.device.setTomorrowTime(args.time);
    return true;
  }

  async set_ev_tomorrow(args) {
    await this.device.setTomorrowPlan(args.plan);
    return true;
  }

  async set_ev_tomorrow_min_soc(args) {
    const soc = Number(args.soc);
    if (!Number.isFinite(soc)) throw Error(this.device.homey.__('error_value_not_number'));
    this.device.log(`[EV Plan] Minimum SoC tomorrow set to ${soc}% via flow`);
    await this.device.setTomorrowMinSoc(soc);
    return true;
  }

  async ev_car_state_is(args) {
    return this.device.getCapabilityValue('ev_car_state') === args.state;
  }

  async ev_charge_mode_is(args) {
    return (this.device.getCapabilityValue('ev_charge_mode') || 'scheduled_price') === args.mode;
  }

}

module.exports = EvFlows;
