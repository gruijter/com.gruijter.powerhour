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
}

module.exports = EvFlows;
