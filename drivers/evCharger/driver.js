/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const crypto = require('crypto');
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
    'ev_charge_mode', 'ev_next_departure', 'ev_target_soc', 'ev_departure_time',
    // Needed by the shared generic_bat_device.js base class (same as drivers/battery/driver.js):
    // meter_power_hidden anchors updateMeterFromMeasure()'s delta baseline and the large-jump
    // anomaly guard in handleUpdateMeter(); without it, updateMeterFromMeasure() silently no-ops
    // on every call for any EV charger paired via the "measure_power only" path (no separate
    // cumulative meter capability on the source device), so kWh/money never accumulate for it.
    // Appended at the end (not interspersed) so migration only adds these, it doesn't reorder or
    // touch any already-declared capability on existing paired devices.
    'meter_power_hidden', 'meter_kwh_charging', 'meter_kwh_discharging',
    // Lets the user force a re-learn of the departure/return model, same as solar's own
    // button.retrain. Also appended at the end for the same DeviceMigrator reason above.
    'button.retrain',
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
    if (this.energyPollCallback) return;
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async onPair(session) {
    const defaultMeasurePower = this.manifest.id === 'evCharger' ? 'measure_power' : undefined;
    const defaultMeasureWatt = this.manifest.id === 'evCharger' ? 'measure_power' : undefined;
    // eslint-disable-next-line global-require
    const { getGridPowerFallback } = require('../../lib/helpers/Util');
    await getGridPowerFallback(this.homey, session, defaultMeasurePower, defaultMeasureWatt);
  }

  async registerEnergyPoller() {
    if (!this.energyPollCallback) return;
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  async startPollingEnergy(interval) {
    this.energyPollCallback = async (report) => {
      // eslint-disable-next-line global-require
      const { getGridPowerFallback } = require('../../lib/helpers/Util');
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
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  // ─── Device compatibility checks ────────────────────────────────────────────

  /**
   * Check if a Homey device is a suitable EV charger (wallbox / smart plug used as charger).
   * Returns { found, useMeasureSource } or { found: false }.
   */
  checkDeviceCompatibility(homeyDevice) {
    // Exclude PBTH's own summary devices, same convention as generic_sum_driver.js
    // (used by gas/solar/water): driverId, not the device's own editable name.
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || []; // guard against null capabilities
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isCharger = false;

    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isCharger = true;
    } else if (energyData && energyData.isEVCharger === true) {
      // Covers smart plugs/sockets too: Homey's own "This device is an EV charger"
      // energy setting, not a guess based on the device's (user-editable) name.
      isCharger = true;
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
    // Exclude PBTH's own summary devices, same convention as generic_sum_driver.js
    // (used by gas/solar/water): driverId, not the device's own editable name.
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || [];
    // 'vehicle' is Homey's official class for cars/bikes/scooters when 'car' doesn't apply
    // (e.g. this developer's own com.kia_hyundai app uses it); virtualClass is the
    // user's explicit "what type is this" override in Homey's device settings.
    const carClasses = ['car', 'vehicle'];
    if (carClasses.includes(homeyDevice.class) || carClasses.includes(homeyDevice.virtualClass)) {
      return { found: true };
    }
    // Fallback for apps that use a generic class (e.g. 'sensor') for their car driver.
    // Require a charge-state capability together with a SoC reading: measure_battery
    // alone is far too common (any battery-powered sensor has it) to be a reliable signal.
    // 'ev_charging_state' is the car/vehicle-class equivalent of 'evcharger_charging_state'
    // (identical enum, see device.js's addSourceCapGroup() for the full explanation).
    const hasChargeState = caps.includes('evcharger_charging_state') || caps.includes('ev_charging_state') || caps.includes('evcharger_charging');
    const hasSoc = caps.includes('measure_battery');
    if (hasChargeState && hasSoc) return { found: true };
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

  // ─── Pairing / repairing ─────────────────────────────────────────────────────

  /**
   * Lists one entry per charger (no car linked), plus one entry per
   * charger+car combination, so the user picks both in a single, familiar
   * device-selection list instead of a separate car-picking step.
   */
  async onPairListDevices() {
    const randomId = crypto.randomBytes(3).toString('hex');
    const allCaps = [...this.ds.deviceCapabilities];
    const [chargers, cars] = await Promise.all([this._listChargerDevices(), this._listCarDevices()]);
    const devices = [];

    chargers.forEach((charger) => {
      const baseSettings = this.getDeviceSettings(charger);
      if (charger.useMeasureSource) baseSettings.use_measure_source = true;

      devices.push({
        name: `${charger.name}_Σ`,
        data: { id: `PH_${this.ds.driverId}_${charger.id}_${randomId}` },
        settings: { ...baseSettings },
        capabilities: allCaps,
      });

      cars.forEach((car) => {
        devices.push({
          name: `${charger.name}_Σ (${car.name})`,
          data: { id: `PH_${this.ds.driverId}_${charger.id}_${car.id}_${randomId}` },
          settings: { ...baseSettings, ev_device_id: car.id, ev_device_name: car.name },
          capabilities: allCaps,
        });
      });
    });

    return devices;
  }

  // Same as the generic_bat_driver base version, but also persists the EV car link.
  async onRepair(session, device) {
    this.log('Repairing of device started', device.getName());
    let selectedDevices = [];
    session.setHandler('list_devices', () => this.onPairListDevices());
    session.setHandler('list_devices_selection', (devices) => {
      selectedDevices = devices;
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'loading') {
        const [dev] = selectedDevices;
        if (!dev || !dev.settings) {
          await session.showView('done');
          throw Error(this.homey.__('error_device_corrupt'));
        }
        const newSettings = {
          homey_device_id: dev.settings.homey_device_id,
          homey_device_name: dev.settings.homey_device_name,
          ev_device_id: dev.settings.ev_device_id,
          ev_device_name: dev.settings.ev_device_name,
        };
        this.log('old settings:', device.getSettings());
        await device.setSettings(newSettings).catch((err) => this.error(err));
        await session.showView('done');
        this.log('new settings:', device.getSettings());
        device.restartDevice().catch((err) => this.error(err));
      }
    });
    session.setHandler('disconnect', () => {
      this.log('Repairing of device ended', device.getName());
    });
  }
}

module.exports = CarChargeDriver;
