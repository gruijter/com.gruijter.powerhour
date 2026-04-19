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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_kwh_this_hour',
    last_hour: 'meter_kwh_last_hour',
    this_day: 'meter_kwh_this_day',
    last_day: 'meter_kwh_last_day',
    this_month: 'meter_kwh_this_month',
    last_month: 'meter_kwh_last_month',
    this_year: 'meter_kwh_this_year',
    last_year: 'meter_kwh_last_year',
    meter_source: 'meter_power',
    measure_source: 'measure_watt_avg',
  },
};

class GridDevice extends GenericDevice {
  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
    this.meterPowerHome = await this.getStoreValue('meterPowerHome') || 0;
    if (this.hasCapability('meter_power.home')) {
      await this.setCapabilityValue('meter_power.home', this.meterPowerHome).catch(this.error);
    }
  }

  async setCapability(capability, value) {
    await super.setCapability(capability, value);
    // Calculate home power real-time in sync with the grid power updates
    if (capability === 'measure_watt_avg') {
      this.calculateHomePower().catch(this.error);
    }
  }

  async calculateHomePower() {
    try {
      const gridPower = this.getCapabilityValue('measure_watt_avg') || 0;

      let solarPower = 0;
      const solarDriver = this.homey.drivers.getDriver('solar');
      if (solarDriver) {
        solarDriver.getDevices().forEach((dev) => {
          solarPower += (dev.getCapabilityValue('measure_power') || 0);
        });
      }

      let batteryPower = 0;
      const batDriver = this.homey.drivers.getDriver('battery');
      if (batDriver) {
        batDriver.getDevices().forEach((dev) => {
          batteryPower += (dev.getCapabilityValue('measure_watt_avg') || 0);
        });
      }

      let evPower = 0;
      const evDriver = this.homey.drivers.getDriver('evCharger');
      if (evDriver) {
        evDriver.getDevices().forEach((dev) => {
          evPower += (dev.getCapabilityValue('measure_watt_avg') || 0);
        });
      }

      // Wiskunde voor eigen verbruik: Grid (import = +) + Solar (prod = +) - Battery (laden = +) - EV (laden = +)
      const homePower = Math.round(gridPower + solarPower - batteryPower - evPower);
      await this.setCapability('measure_power.home', homePower).catch(this.error);

      const now = Date.now();
      if (this.lastHomePowerCalcTm) {
        const dt = now - this.lastHomePowerCalcTm; // ms
        if (dt > 0 && dt < 300000) {
          const safePower = Math.max(0, this.lastHomePower || 0);
          const deltaKwh = (safePower * dt) / 3600000000;
          this.meterPowerHome = (this.meterPowerHome || 0) + deltaKwh;
          await this.setCapability('meter_power.home', Number(this.meterPowerHome.toFixed(4))).catch(this.error);

          if (!this.lastHomePowerSaveTm || (now - this.lastHomePowerSaveTm > 60000)) {
            this.setStoreValue('meterPowerHome', this.meterPowerHome).catch(this.error);
            this.lastHomePowerSaveTm = now;
          }
        }
      }
      this.lastHomePower = homePower;
      this.lastHomePowerCalcTm = now;
    } catch (err) {
      this.error('Error calculating home power:', err);
    }
  }

  getActiveTariff(reading, tariff, exportTariff) {
    let activeTariff = tariff;
    const tariffType = this.getSettings().tariff_type || 'dynamic';

    if (tariffType === 'import') {
      activeTariff = tariff;
    } else if (tariffType === 'export') {
      activeTariff = exportTariff;
    } else {
      const livePower = this.getCapabilityValue(this.ds.cmap.measure_source);

      if (typeof livePower === 'number') {
        activeTariff = livePower >= 0 ? tariff : exportTariff;
      } else {
        // fallback: check meter delta
        const deltaMeter = reading.meterValue - this.meterMoney.meterValue;
        activeTariff = deltaMeter >= 0 ? tariff : exportTariff;
      }
    }
    return activeTariff;
  }

  async addSourceCapGroup() {
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters

    const energyData = this.sourceDevice.energyObj || this.sourceDevice.energy;

    if (energyData && energyData.cumulative === true) {
      const importedCap = energyData.cumulativeImportedCapability || 'meter_power';
      const exportedCap = energyData.cumulativeExportedCapability;

      const group = {
        p1: null, p2: null, n1: null, n2: null,
      };

      if (this.sourceDevice.capabilities.includes(importedCap)) {
        group.p1 = importedCap;
      }

      if (exportedCap && this.sourceDevice.capabilities.includes(exportedCap)) {
        group.n1 = exportedCap;
      }

      if (group.p1 || group.n1) {
        this.sourceCapGroup = group;
        return;
      }
    }

    throw Error(`${this.sourceDevice.name} has no compatible grid capabilities defined in the energy object.`);
  }
}

module.exports = GridDevice;
