/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const crypto = require('crypto');
const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EvCarCaps = require('../../lib/helpers/EvCarCaps');
const EvHistory = require('../../lib/helpers/EvHistory');
const PairSetup = require('../../lib/helpers/PairSetup');
const SourceCaps = require('../../lib/helpers/SourceCaps');
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    // Live power and the car first: what the device tile and the device page lead with.
    'measure_watt_avg', 'ev_car_state', 'measure_ev_soc', 'ev_next_departure', 'ev_next_charge', 'ev_resume',
    'ev_charge_mode', 'ev_tomorrow_time', 'ev_tomorrow',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power',
    // Needed by the shared generic_bat_device.js base class (same as drivers/battery/driver.js):
    // meter_power_hidden anchors updateMeterFromMeasure()'s delta baseline and the large-jump
    // anomaly guard in handleUpdateMeter(); without it, updateMeterFromMeasure() silently no-ops
    // on every call for any EV charger paired via the "measure_power only" path (no separate
    // cumulative meter capability on the source device), so kWh/money never accumulate for it.
    'meter_power_hidden', 'meter_kwh_charging', 'meter_kwh_discharging',
    // Lets the user force a re-learn from Insights history, same as solar's own button.retrain.
    'button.retrain',
    // Not plugged in while the next departure needs charge (solar's alarm_power: last, own title).
    'alarm_generic',
  ],
  // Canonical display order for this driver's chart images - see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'todayChargeChart', prop: 'todayChargeImage', chartProp: 'chartTodayCharge', titleKey: 'today',
    },
    {
      id: 'tomorrowChargeChart', prop: 'tomorrowChargeImage', chartProp: 'chartTomorrowCharge', titleKey: 'tomorrow',
    },
    {
      id: 'nextHoursChargeChart', prop: 'nextHoursChargeImage', chartProp: 'chartNextHoursCharge', titleKey: 'nextHours',
    },
    {
      id: 'yesterdayChargeChart', prop: 'yesterdayChargeImage', chartProp: 'chartYesterdayCharge', titleKey: 'yesterday',
    },
    // Added later, so last: an image's position is fixed when first registered.
    {
      id: 'evWeeklyChart', prop: 'evWeeklyImage', chartProp: 'chartEvWeekly', titleKey: 'ev_weekly',
    },
  ],
  // Asked at pair and repair (lib/helpers/PairSetup.js); chargerControl shown on, also at repair.
  setup: {
    settings: ['chargePower', 'batCapacity', 'variableChargePower', 'tariff_update_group', 'chargerControl'],
    preset: { chargerControl: true },
    match: { classes: ['evcharger'], energy: (energy) => energy.isEVCharger === true },
  },
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
    } catch { /* ignore */ }
    if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
    const allDevices = await api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
    return allDevices || {};
  }

  async _listChargerDevices() {
    try {
      const allDevices = await this._getAllHomeyDevices();
      const listed = [];

      Object.values(allDevices).forEach((homeyDevice) => {
        const compat = this.checkDeviceCompatibility(homeyDevice);
        if (!compat.found) return;

        listed.push({
          device: { id: homeyDevice.id, name: homeyDevice.name, useMeasureSource: !!compat.useMeasureSource },
          score: PairSetup.listScore(this, homeyDevice, compat),
        });
      });

      return PairSetup.sortByScore(listed);
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

        // A car or vehicle by its class first, then those found by their capabilities.
        const isCar = ['car', 'vehicle'].some((c) => c === homeyDevice.class || c === homeyDevice.virtualClass);
        listed.push({ device: { id: homeyDevice.id, name: homeyDevice.name }, score: isCar ? 1 : 0 });
      });

      return PairSetup.sortByScore(listed);
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
    const [chargers, cars] = await Promise.all([this._listChargerDevices(), this._listCarDevices()]);
    const devices = [];

    chargers.forEach((charger) => {
      const baseSettings = this.getDeviceSettings(charger);
      if (charger.useMeasureSource) baseSettings.use_measure_source = true;

      devices.push({
        name: `${charger.name}_Σ`,
        data: { id: `PH_${this.ds.driverId}_${charger.id}_${randomId}` },
        settings: { ...baseSettings },
        capabilities: this.capabilitiesFor(baseSettings),
      });

      cars.forEach((car) => {
        devices.push({
          name: `${charger.name}_Σ (${car.name})`,
          data: { id: `PH_${this.ds.driverId}_${charger.id}_${car.id}_${randomId}` },
          settings: { ...baseSettings, ev_device_id: car.id, ev_device_name: car.name },
          capabilities: this.capabilitiesFor(baseSettings),
        });
      });
    });

    return devices;
  }

  // The capability list for these settings: paired with it, and kept on it by the device's
  // migration (correctCapabilities), so a new device does not migrate right away.
  capabilitiesFor(settings = {}) {
    let caps = [...this.ds.deviceCapabilities];
    // Budget targets only with a budget, discharging only with V2X.
    if (!settings.distribution || settings.distribution === 'NONE') caps = caps.filter((cap) => !cap.includes('meter_target'));
    if (!settings.v2x) caps = caps.filter((cap) => cap !== 'meter_kwh_discharging');
    return caps;
  }

  // The car link comes with the listed charger too.
  sourceSettingIds() {
    return [...super.sourceSettingIds(), 'ev_device_id', 'ev_device_name'];
  }

  // Setup view: the hint of charger control, and the charge power measured by the charger.
  async setupInfo(setting, def, dev, current) {
    if (setting.id === 'chargerControl') return PairSetup.text(this.homey, def.hint);
    if (setting.id !== 'chargePower') return undefined;
    // Measured by the repaired device, when the charger stays the same.
    const sameCharger = current.device && dev.settings.homey_device_id === current.device.getSettings().homey_device_id;
    const measured = (sameCharger && current.device.getStoreValue('detectedMaxPower'))
      || await this._measuredChargePower(dev.settings.homey_device_id);
    return measured
      ? this.homey.__('repair.setup_power_measured', { power: measured })
      : this.homey.__('repair.setup_power_unmeasured', { power: EvHistory.DEFAULT_CHARGE_POWER_W });
  }

  // Setup view: with a car, per role the fitting capabilities of that car.
  async setupRoles(dev, stored) {
    const carId = dev.settings.ev_device_id;
    const car = carId && carId !== 'none' && this.homey.app.api
      ? await this.homey.app.api.devices.getDevice({ id: carId, $cache: false }).catch(() => null) : null;
    const title = this.homey.__('repair.car_caps_title');
    if (!car) {
      return {
        deviceId: null, title, text: this.homey.__('repair.car_no_car'), items: [],
      };
    }
    const chosen = stored && stored.carId === carId ? stored.caps : {};
    const items = EvCarCaps.carCapOptions(car).map((role) => ({
      key: role.key,
      label: this.homey.__(`repair.car_${role.key}`),
      auto: role.auto,
      options: role.options.map((opt) => ({ id: opt.id, label: SourceCaps.describe(car, opt.id) })),
      selected: chosen[role.key] || 'auto',
    }));
    return {
      deviceId: car.id, title, text: `${car.name}. ${this.homey.__('repair.car_caps_text')}`, items,
    };
  }

  setupStored(device) {
    return device.getStoreValue('evCarCaps');
  }

  setupStore(carId, caps) {
    return { key: 'evCarCaps', value: { carId, caps } };
  }

  // Charge power (W) from the charger's Insights power history, or null.
  async _measuredChargePower(chargerId) {
    const { api } = this.homey.app;
    if (!api || !chargerId) return null;
    const allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
    const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 42 * 24 * 60 * 60 * 1000);
    const entries = await EvHistory.fetchPowerLog({
      api, logs, deviceId: chargerId, capNames: ['energy_power', 'meter_power'], startDate, endDate,
    }).catch(() => null);
    return EvHistory.detectChargePower(entries);
  }
}

module.exports = CarChargeDriver;
