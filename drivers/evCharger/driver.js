/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const crypto = require('crypto');
const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EvCarCaps = require('../../lib/helpers/EvCarCaps');
const EvChargerCaps = require('../../lib/helpers/EvChargerCaps');
const EvChargerControl = require('../../lib/strategies/EvChargerControl');
const EvHistory = require('../../lib/helpers/EvHistory');
const PairSetup = require('../../lib/helpers/PairSetup');
const Budget = require('../../lib/Budget');

// The screens of the setup view, in order (lib/helpers/PairSetup.js).
const STEPS = [
  { id: 'device', ids: [], roles: true },
  { id: 'charger', ids: ['chargerControl', 'chargePower', 'variableChargePower', 'standbyOn', 'sharedCharger', 'v2x'] },
  { id: 'car', ids: ['batCapacity', 'carStartCharge'] },
  { id: 'levels', ids: ['floorSoc', 'reserveSoc', 'reserveHours', 'maxSoc'] },
  { id: 'ev_price', ids: ['tariff_update_group', 'tariff_type', 'cheapCharge', 'cheapPrice', 'maxPrice', 'solarGridPower'] },
  { id: 'departure', ids: [0, 1, 2, 3, 4, 5, 6].map((day) => `departureTime_${day}`), optional: true },
  { id: 'year', ids: [] },
  {
    id: 'advanced',
    ids: ['overrideMaxHours', 'autoDepartureLearning', 'minTripSoc', 'chartShowPower', 'chartShowSoc', 'chartShowExportPrice', 'chartShowLegend'],
    optional: true,
  },
];
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    // Live power and the car first: what the device tile and the device page lead with.
    'measure_watt_avg', 'ev_car_state', 'measure_ev_soc', 'ev_next_departure', 'ev_next_charge', 'ev_resume',
    'ev_charge_mode', 'ev_today_time', 'ev_today', 'ev_tomorrow_time', 'ev_tomorrow',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power',
    // Needed by generic_bat_device.js: without it updateMeterFromMeasure() has no baseline and kWh
    // and money never accumulate.
    'meter_power_hidden', 'meter_kwh_charging', 'meter_kwh_discharging',
    'button.retrain',
    // Not plugged in while the next departure needs charge (solar's alarm_power: last, own title).
    'alarm_generic',
  ],
  // Chart image order, see lib/helpers/ChartImages.js.
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
  // Asked at pair and repair (lib/helpers/PairSetup.js), not on the settings page; chargerControl
  // on when pairing.
  setup: {
    settings: STEPS.flatMap((st) => st.ids),
    steps: STEPS,
    preset: { chargerControl: true },
    match: { classes: ['evcharger'], energy: (energy) => energy.isEVCharger === true },
  },
};

class CarChargeDriver extends GenericDriver {
  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Polling starts with the first device (checkStartPolling).
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
    // Exclude PBTH's own devices (by driverId, not the editable name).
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || []; // guard against null capabilities
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isCharger = false;

    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isCharger = true;
    } else if (energyData && energyData.isEVCharger === true) {
      // Homey's "This device is an EV charger" energy setting.
      isCharger = true;
    }

    if (isCharger) {
      const hasMeter = !!EvChargerControl.meterCap(homeyDevice, true);
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
    // Exclude PBTH's own devices (by driverId, not the editable name).
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || [];
    // virtualClass: the user's device type override in Homey.
    const carClasses = ['car', 'vehicle'];
    if (carClasses.includes(homeyDevice.class) || carClasses.includes(homeyDevice.virtualClass)) {
      return { found: true };
    }
    // Homey's "electric car" energy setting, also on a generic class (eu.nissanconnect: sensor).
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    if (energyData && energyData.electricCar === true) return { found: true };
    // Generic class (e.g. 'sensor'): a charge state together with a SoC (measure_battery alone is
    // too common). 'ev_charging_state' is the car-class twin of 'evcharger_charging_state'.
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
        const energyData = homeyDevice.energyObj || homeyDevice.energy;
        const isCar = ['car', 'vehicle'].some((c) => c === homeyDevice.class || c === homeyDevice.virtualClass)
          || !!(energyData && energyData.electricCar === true);
        listed.push({ device: { id: homeyDevice.id, name: homeyDevice.name }, score: isCar ? 1 : 0 });
      });

      return PairSetup.sortByScore(listed);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // ─── Pairing / repairing ─────────────────────────────────────────────────────

  // The paired device is named after the charger; the list also shows the car.
  sourceName(dev) {
    return dev.settings.homey_device_name;
  }

  /**
   * One entry per charger, plus one per charger+car combination: both picked in one list.
   */
  async onPairListDevices() {
    const randomId = crypto.randomBytes(3).toString('hex');
    const [chargers, cars] = await Promise.all([this._listChargerDevices(), this._listCarDevices()]);
    const devices = [];

    chargers.forEach((charger) => {
      const baseSettings = this.getDeviceSettings(charger);
      if (charger.useMeasureSource) baseSettings.use_measure_source = true;

      devices.push({
        name: charger.name,
        data: { id: `PH_${this.ds.driverId}_${charger.id}_${randomId}` },
        settings: { ...baseSettings },
        capabilities: this.capabilitiesFor(baseSettings),
      });

      cars.forEach((car) => {
        devices.push({
          name: `${charger.name} (${car.name})`,
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
    if (!Budget.isActive(settings.distribution, settings.budget)) caps = caps.filter((cap) => !cap.includes('meter_target'));
    if (!settings.v2x) caps = caps.filter((cap) => cap !== 'meter_kwh_discharging');
    return caps;
  }

  // The car link comes with the listed charger too.
  sourceSettingIds() {
    return [...super.sourceSettingIds(), 'ev_device_id', 'ev_device_name'];
  }

  // Minimum SoC <= reserve SoC <= daily maximum SoC.
  async setupValidate(settings) {
    const soc = (id) => Number(settings[id]);
    if (soc('floorSoc') > soc('reserveSoc') || soc('reserveSoc') > soc('maxSoc')) throw Error(this.homey.__('error_setup_soc_order'));
  }

  // Setup view: the charge power measured by the charger.
  async setupInfo(setting, def, dev, current) {
    if (setting.id !== 'chargePower') return undefined;
    // Measured by the repaired device, when the charger stays the same.
    const sameCharger = current.device && dev.settings.homey_device_id === current.device.getSettings().homey_device_id;
    const measured = (sameCharger && current.device.getStoreValue('detectedMaxPower'))
      || await this._measuredChargePower(dev.settings.homey_device_id);
    return measured
      ? this.homey.__('repair.setup_power_measured', { power: measured })
      : this.homey.__('repair.setup_power_unmeasured', { power: EvHistory.DEFAULT_CHARGE_POWER_W });
  }

  // Setup view: per role the fitting capabilities of the charger and, with a car, of the car.
  // Charger roles are keyed charger_<role>.
  async setupRoles(dev, storedRoles) {
    const stored = storedRoles || {};
    const chargerId = dev.settings.homey_device_id;
    const carId = dev.settings.ev_device_id;
    const charger = await PairSetup.apiDevice(this, chargerId);
    const car = carId && carId !== 'none' ? await PairSetup.apiDevice(this, carId) : null;
    if (!charger) return null;
    const label = (key) => this.homey.__(`repair.${key}`);
    const chargerChosen = stored.charger && stored.charger.chargerId === chargerId ? stored.charger.caps : {};
    const carChosen = car && stored.car && stored.car.carId === carId ? stored.car.caps : {};
    const items = [
      ...EvChargerCaps.chargerCapRows(charger, chargerChosen, label),
      ...(car ? EvCarCaps.carCapRows(car, carChosen, label) : []),
    ];
    const names = car ? `${charger.name}, ${car.name}` : `${charger.name}. ${this.homey.__('repair.car_no_car')}`;
    return {
      deviceId: chargerId, title: this.homey.__('repair.ev_caps_title'), text: `${names}. ${this.homey.__('repair.ev_caps_text')}`, items,
    };
  }

  setupStored(device) {
    return { charger: device.getStoreValue('evChargerCaps'), car: device.getStoreValue('evCarCaps') };
  }

  setupStore(chargerId, caps, dev) {
    const part = (prefix) => Object.fromEntries(Object.entries(caps)
      .filter(([key]) => key.startsWith(prefix)).map(([key, id]) => [key.slice(prefix.length), id]));
    const carId = dev && dev.settings.ev_device_id;
    const stores = [{ key: 'evChargerCaps', value: { chargerId, caps: part('charger_') } }];
    // No car rows (the car could not be read): the choice made before is kept.
    const carCaps = part('car_');
    if (carId && carId !== 'none' && Object.keys(carCaps).length) stores.push({ key: 'evCarCaps', value: { carId, caps: carCaps } });
    return stores;
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
