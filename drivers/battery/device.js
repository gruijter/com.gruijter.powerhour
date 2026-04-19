/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');

class BatDevice extends GenericDevice {

  async onInit() {
    await super.onInit().catch(this.error);
    const currentSessionId = this.sessionId;
    if (this.getSettings().roiEnable) {
      this.homey.setTimeout(async () => {
        await new Promise((resolve) => this.homey.setTimeout(resolve, 10000 + (Math.random() * 60000)));
        if (this.sessionId !== currentSessionId) return;
        if (this.pricesNextHours) {
          await this.flows.triggerNewRoiStrategyFlow().catch((err) => this.error(err));
          await this.updateChargeChart().catch((err) => this.error(err));
        }
      }, 0);
    }
  }

  async onPricesUpdated() {
    if (this.getSettings().roiEnable) {
      await this.flows.triggerNewRoiStrategyFlow();
      await this.updateChargeChart();
    }
  }

  async addSourceCapGroup() {
    // 1. Check for new Homey energy standard (battery class)
    if (this.sourceDevice.class === 'battery' || this.sourceDevice.virtualClass === 'battery') {

      const hasCapability = (capability) => this.sourceDevice.capabilities.includes(capability);
      let soc = null;
      let newMeasurePower = null;
      let chargingState = null;
      let meterCharging = null;
      let meterDischarging = null;

      if (hasCapability('measure_battery')) soc = 'measure_battery';
      if (hasCapability('measure_power')) newMeasurePower = 'measure_power';
      if (hasCapability('battery_charging_state')) chargingState = 'battery_charging_state';

      const energyData = this.sourceDevice.energyObj || this.sourceDevice.energy;
      if (energyData?.meterPowerImportedCapability && hasCapability(energyData.meterPowerImportedCapability)) {
        meterCharging = energyData.meterPowerImportedCapability;
      }
      if (energyData?.meterPowerExportedCapability && hasCapability(energyData.meterPowerExportedCapability)) {
        meterDischarging = energyData.meterPowerExportedCapability;
      }

      if (soc && newMeasurePower) {
        this.sourceCapGroup = {
          soc,
          newMeasurePower,
          chargingState,
          meterCharging,
          meterDischarging,
        };
        return;
      }
    }

    // setup if/how a HOMEY-API source device fits to a defined capability group
    this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
  }

  async addListeners() {
    // check if source device exists
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    // start listeners for all caps
    await this.addSourceCapGroup();
    this.log(`registering capability listeners for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          await this.updateValue(value, key).catch(this.error);
        });
      }
    });
  }

  async poll() {
    // check if source device exists
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      return;
    }
    if (!api) return;
    await this.getSourceDevice();

    // start polling all caps
    if (!this.sourceCapGroup) await this.addSourceCapGroup();
    this.log(`polling ${this.sourceDevice.name}`);
    const promises = Object.keys(this.sourceCapGroup).map(async (key) => {
      if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]]) {
        const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]].value;
        await this.updateValue(val, key).catch(this.error);
      }
    });
    await Promise.all(promises);
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    this.log('updating charge chart', this.getName());
    const minPriceDelta = this.getSettings().roiMinProfit;
    const strategy = await this.flows.find_roi_strategy({ minPriceDelta }).catch((err) => this.error(err));
    if (strategy) {
      await this.setCapability('roi_duration', strategy.duration).catch((err) => this.error(err));
      if (this.pricesNextHoursIsForecast) {
        const scheme = JSON.parse(strategy.scheme);
        Object.keys(scheme).forEach((k) => {
          if (this.pricesNextHoursIsForecast[k]) scheme[k].isForecast = true;
        });
        strategy.scheme = JSON.stringify(scheme);
      }
      const now = new Date();
      now.setMilliseconds(0);
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
      const H0 = nowLocal.getHours();
      const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;
      const startHour = H0 + (M0 / 60);
      // eslint-disable-next-line max-len
      const chartNextHours = await getChargeChart(strategy, startHour, this.pricesNextHoursMarketLength, this.getSettings().chargePower, this.getSettings().dischargePower, this.priceInterval, this.exportPricesNextHours);
      this.chartNextHoursCharge = chartNextHours;
      if (!this.nextHoursChargeImage) {
        this.nextHoursChargeImage = await this.homey.images.createImage();
        this.nextHoursChargeImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursCharge, stream, this));
        await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
      }
      await this.nextHoursChargeImage.update().catch((err) => this.error(err));
    }
  }

  triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower) {
    if (!this.flows) return Promise.resolve(false);
    return this.flows.triggerXomFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
  }
}

module.exports = BatDevice;
