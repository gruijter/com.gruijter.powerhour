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
      this.device.lastKnownSoc = args.soc;
      await this.device.setStoreValue('lastKnownSoc', this.device.lastKnownSoc).catch(this.device.error);
      this.device.log(`Manual EV SoC set to ${args.soc}% via flow`);
      await this.device.updateChargeChart().catch(this.device.error);
    }
    return true;
  }

  async set_ev_departure(args) {
    const { departureTime, targetSoc } = args;
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(departureTime)) {
      throw new Error(`Invalid departure time format: ${departureTime}. Use HH:MM`);
    }
    if (typeof targetSoc !== 'number' || targetSoc < 0 || targetSoc > 100) {
      throw new Error(`Invalid target SoC: ${targetSoc}`);
    }

    this.device.log(`Manual EV departure set to ${departureTime}, target SoC ${targetSoc}% via flow`);
    await this.device.setSettings({ departureTime, targetSoc: Number(targetSoc) }).catch(this.device.error);
    return true;
  }
}

module.exports = EvFlows;
