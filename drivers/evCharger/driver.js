/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power', 'measure_watt_avg', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max',
  ],
};

class CarChargeDriver extends GenericDriver {
  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Only initialize polling if there are devices.
    // If a device is paired later, checkStartPolling will handle it.
    if (this.getDevices().length > 0) {
      await this.checkStartPolling();
    }
  }

  async checkStartPolling() {
    if (this.energyPollCallback) return; // Already polling
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    await this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    this.energyPollCallback = async (report) => {
      // eslint-disable-next-line global-require
      const { getGridPowerFallback } = require('../../lib/Util');
      let cumulativePower = getGridPowerFallback(this.homey);
      if (cumulativePower === null) cumulativePower = report?.totalCumulative?.W;

      if (Number.isFinite(cumulativePower)) {
        const devices = this.getDevices();
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;
        });
      }
    };
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  // ─── Device compatibility checks ────────────────────────────────────────────

  /**
   * Check if a Homey device is a suitable EV charger (wallbox / smart plug used as charger).
   * Returns { found, useMeasureSource } or { found: false }.
   */
  checkDeviceCompatibility(homeyDevice) {
    const caps = homeyDevice.capabilities || []; // guard against null capabilities
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isCharger = false;

    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isCharger = true;
    } else if (energyData && energyData.isEVCharger === true) {
      isCharger = true;
    } else if (homeyDevice.class === 'socket' || homeyDevice.class === 'other' || homeyDevice.class === 'heater') {
      // Smart plugs: only match if tagged as isEVCharger or name contains charger/lader/ev/wallbox/laadpaal
      const name = (homeyDevice.name || '').toLowerCase();
      if (energyData?.isEVCharger === true || /ev|charger|lader|wallbox|laadpaal/i.test(name)) {
        isCharger = true;
      }
    }

    if (isCharger) {
      const hasMeter = caps.includes('meter_power');
      const hasMeasure = caps.includes('measure_power');
      const useMeasureSource = !hasMeter && hasMeasure;
      if (hasMeter || hasMeasure) {
        return { found: true, useMeasureSource };
      }
    }

    return { found: false };
  }

  /**
   * Check if a Homey device is a suitable EV car (provides SoC or connection state).
   * Returns { found: true } or { found: false }.
   */
  checkCarCompatibility(homeyDevice) {
    const caps = homeyDevice.capabilities || [];
    // Exclude PBTH's own summary devices
    const name = homeyDevice.name || '';
    if ((homeyDevice.driverUri || '').includes('powerhour') || name.endsWith('_Σ') || name.endsWith('_ΣEV')) {
      return { found: false };
    }
    if (homeyDevice.class === 'car' || homeyDevice.virtualClass === 'car') return { found: true };
    if (caps.includes('measure_battery') || caps.includes('evcharger_charging_state')) {
      return { found: true };
    }
    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    return {
      homey_device_id: homeyDevice.id,
      homey_device_name: homeyDevice.name,
      ev_device_id: 'none',
      ev_device_name: 'none',
      level: this.homey.app.manifest.version,
      tariff_update_group: 1,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  async _getAllHomeyDevices() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) { /* ignore */ }
    if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
    const allDevices = await api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
    return allDevices || {};
  }

  async _listChargerDevices() {
    try {
      const allDevices = await this._getAllHomeyDevices();
      const allCaps = [...this.ds.deviceCapabilities];
      const listed = [];

      Object.values(allDevices).forEach((homeyDevice) => {
        const compat = this.checkDeviceCompatibility(homeyDevice);
        if (!compat.found) return;

        listed.push({
          id: homeyDevice.id,
          name: homeyDevice.name,
          useMeasureSource: !!compat.useMeasureSource,
          capabilities: allCaps,
        });
      });

      return listed;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async _listCarDevices() {
    try {
      const allDevices = await this._getAllHomeyDevices();
      const listed = [];

      Object.values(allDevices).forEach((homeyDevice) => {
        const compat = this.checkCarCompatibility(homeyDevice);
        if (!compat.found) return;

        listed.push({
          id: homeyDevice.id,
          name: homeyDevice.name,
        });
      });

      return listed;
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

module.exports = CarChargeDriver;
