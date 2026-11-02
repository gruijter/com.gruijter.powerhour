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

  // That day's departure and/or minimum SoC, once; an empty field stays. Time: HH:MM (may come
  // from a tag), 'auto' or '-' (car not used). SoC 0: automatic again.
  async set_ev_departure(args) {
    const { day } = args;
    const input = String(args.time ?? '').trim();
    const hasSoc = args.soc !== undefined && args.soc !== null && args.soc !== '';
    const soc = Number(args.soc);
    if (hasSoc && !Number.isFinite(soc)) throw Error(this.device.homey.__('error_value_not_number'));
    if (hasSoc && soc !== 0 && (soc < 30 || soc > 100)) throw Error(this.device.homey.__('error_ev_min_soc'));
    if (input) {
      let value = null;
      if (/^auto/i.test(input)) value = 'auto';
      else if (input === '-') value = 'unused';
      else value = EvPlanner.parseTime(input);
      if (!value) throw Error(this.device.homey.__('error_invalid_time', { time: args.time }));
      this.device.log(`[EV Plan] Departure ${day} set to ${value} via flow`);
      await this.device.setDayTime(day, value);
    }
    // Not used that day: no minimum SoC.
    if (hasSoc && input !== '-') {
      this.device.log(`[EV Plan] Minimum SoC ${day} set to ${soc ? `${soc}%` : 'auto'} via flow`);
      if (soc === 0) await this.device.setDayPlan(day, 'auto');
      else await this.device.setDayMinSoc(day, soc);
    }
    return true;
  }

  async add_ev_away_period(args) {
    await this.device.addAwayPeriod(args.from, args.to);
    return true;
  }

  async set_ev_presence(args) {
    await this.device.setFlowPresence(args.presence);
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
