/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const crypto = require('crypto');
const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
const EvCarCaps = require('../../lib/helpers/EvCarCaps');
const EvChargerCaps = require('../../lib/helpers/EvChargerCaps');
const EvChargerControl = require('../../lib/strategies/EvChargerControl');
const EvHistory = require('../../lib/helpers/EvHistory');
const PairSetup = require('../../lib/helpers/PairSetup');
const Budget = require('../../lib/Budget');

const STEPS = [
  { id: 'device', ids: [], roles: true },
  { id: 'charger', ids: ['chargerControl', 'chargePower', 'variableChargePower', 'minChargeMinutes', 'chargerPhase', 'chargerBalancing'] },
  { id: 'car', ids: ['batCapacity', 'carStartCharge', 'floorSoc', 'reserveSoc', 'reserveHours', 'maxSoc'] },
  { id: 'ev_price', ids: ['tariff_update_group', 'cheapCharge', 'cheapPrice', 'maxPrice', 'solarGridPower'] },
  { id: 'departure', ids: [0, 1, 2, 3, 4, 5, 6].map((day) => `departureTime_${day}`), optional: true },
  { id: 'year', ids: [], optional: 'pair' },
  {
    id: 'advanced',
    ids: ['autoDepartureLearning', 'minTripSoc', 'overrideMaxHours', 'tariff_type', 'standbyOn', 'sharedCharger', 'v2x',
      'chartShowPower', 'chartShowSoc', 'chartShowExportPrice', 'chartShowLegend'],
    repairOnly: true,
  },
];

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    'measure_watt_avg', 'ev_car_state', 'measure_ev_soc', 'ev_next_departure', 'ev_next_charge', 'ev_resume',
    'ev_charge_mode', 'ev_today_time', 'ev_today', 'ev_tomorrow_time', 'ev_tomorrow',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff',
    'meter_power_hidden', 'meter_kwh_charging', 'meter_kwh_discharging',
    'button.retrain',
    'alarm_generic',
  ],
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
    {
      id: 'evWeeklyChart', prop: 'evWeeklyImage', chartProp: 'chartEvWeekly', titleKey: 'ev_weekly',
    },
  ],
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
  }

  async onEnergyReport(report) {
    const gridW = await EnergyPollingHelper.gridPowerW(report);
    if (!Number.isFinite(gridW)) return;
    this.getDevices().forEach((device) => {
      device.currentGridPower = gridW;
    });
  }

  checkDeviceCompatibility(homeyDevice) {
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || [];
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isCharger = false;

    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isCharger = true;
    } else if (energyData && energyData.isEVCharger === true) {
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

  checkCarCompatibility(homeyDevice) {
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || [];
    const carClasses = ['car', 'vehicle'];
    if (carClasses.includes(homeyDevice.class) || carClasses.includes(homeyDevice.virtualClass)) {
      return { found: true };
    }
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    if (energyData && energyData.electricCar === true) return { found: true };
    const hasChargeState = caps.includes('evcharger_charging_state') || caps.includes('ev_charging_state') || caps.includes('evcharger_charging');
    const hasSoc = caps.includes('measure_battery');
    if (hasChargeState && hasSoc) return { found: true };
    return { found: false };
  }

  sourceKey(settings) {
    return settings.homey_device_id ? `${settings.homey_device_id}|${settings.ev_device_id || 'none'}` : null;
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

  async _getAllHomeyDevices() {
    let api;
    try {
      api = this.homey.app.api;
    } catch { }
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

  sourceName(dev) {
    return dev.settings.homey_device_name;
  }

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

  capabilitiesFor(settings = {}) {
    let caps = [...this.ds.deviceCapabilities];
    if (!Budget.isActive(settings.distribution, settings.budget)) caps = caps.filter((cap) => !cap.includes('meter_target'));
    if (!settings.v2x) caps = caps.filter((cap) => cap !== 'meter_kwh_discharging');
    if (settings.v2x) ['hour', 'day', 'month', 'year'].forEach((p) => caps.push(`meter_kwh_this_${p}.charged`, `meter_kwh_this_${p}.discharged`));
    if (settings.v2x) caps.push('meter_kwh_last_day.charged', 'meter_kwh_last_day.discharged');
    return caps;
  }

  sourceSettingIds() {
    return [...super.sourceSettingIds(), 'ev_device_id', 'ev_device_name'];
  }

  async setupValidate(settings) {
    const soc = (id) => Number(settings[id]);
    if (soc('floorSoc') > soc('reserveSoc') || soc('reserveSoc') > soc('maxSoc')) throw Error(this.homey.__('error_setup_soc_order'));
  }

  async setupInfo(setting, def, dev, current) {
    if (setting.id !== 'chargePower') return undefined;
    const sameCharger = current.device && dev.settings.homey_device_id === current.device.getSettings().homey_device_id;
    const measured = (sameCharger && current.device.getStoreValue('detectedMaxPower'))
      || await this._measuredChargePower(dev.settings.homey_device_id);
    return measured
      ? this.homey.__('repair.setup_power_measured', { power: measured })
      : this.homey.__('repair.setup_power_unmeasured', { power: EvHistory.DEFAULT_CHARGE_POWER_W });
  }

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
    const carCaps = part('car_');
    if (carId && carId !== 'none' && Object.keys(carCaps).length) stores.push({ key: 'evCarCaps', value: { carId, caps: carCaps } });
    return stores;
  }

  async _measuredChargePower(chargerId) {
    const { api } = this.homey.app;
    if (!api || !chargerId) return null;
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 42 * 24 * 60 * 60 * 1000);
    const entries = await EvHistory.fetchPowerLog({
      api, deviceId: chargerId, capNames: ['energy_power', 'meter_power'], startDate, endDate,
    }).catch(() => null);
    return EvHistory.detectChargePower(entries);
  }
}

module.exports = CarChargeDriver;
