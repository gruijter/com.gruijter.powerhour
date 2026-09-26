/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const BatFlows = require('./BatFlows');

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

  // Legacy card (hidden for new flows): a target SoC at the next occurrence of a time.
  async set_ev_departure(args) {
    return this.set_ev_trip_override(args);
  }

  async set_ev_charge_mode(args) {
    if (!args.mode) throw new Error('Missing charge mode');
    if (args.mode === 'solar_and_grid') args.mode = 'scheduled_price'; // merged into Smart
    this.device.log(`Setting EV charge mode to ${args.mode} via flow`);
    await this.device.setCapabilityValue('ev_charge_mode', args.mode).catch(this.device.error);
    if (this.device.homey.app.trigger_ev_charge_mode_changed) {
      await this.device.homey.app.trigger_ev_charge_mode_changed(this.device, { mode: args.mode }, {}).catch(this.device.error);
    }
    await this.device.updateChargeChart().catch(this.device.error);
    return true;
  }

  async set_ev_trip_override(args) {
    const { departureTime, targetSoc } = args;
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(departureTime)) {
      throw new Error(`Invalid departure time format: ${departureTime}. Use HH:MM`);
    }
    const trip = {
      departureTime,
      targetSoc: Number(targetSoc) || 80,
      timestamp: Date.now(),
    };
    await this.device.setStoreValue('tripOverride', trip);
    this.device.log(`Temporary EV trip override set to ${departureTime}, SoC ${trip.targetSoc}%`);
    await this.device.updateChargeChart().catch(this.device.error);
    return true;
  }

  async clear_ev_trip_override() {
    await this.device.setStoreValue('tripOverride', null);
    this.device.log('Temporary EV trip override cleared');
    await this.device.updateChargeChart().catch(this.device.error);
    return true;
  }

  async set_ev_tomorrow(args) {
    await this.device.setTomorrowPlan(args.plan);
    return true;
  }

  async set_ev_boost(args) {
    await this.device.setBoost(args.soc, args.time);
    return true;
  }

  async ev_car_state_is(args) {
    return this.device.getCapabilityValue('ev_car_state') === args.state;
  }

  async ev_charge_mode_is(args) {
    const currentMode = this.device.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    // 'solar_and_grid' (older flows) was merged into 'scheduled_price'
    return currentMode === (args.mode === 'solar_and_grid' ? 'scheduled_price' : args.mode);
  }
}

module.exports = EvFlows;
