/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const EvChargeStrategy = require('../../lib/strategies/EvChargeStrategy');
const EvDepartureStrategy = require('../../lib/strategies/EvDepartureStrategy');
const EvFlows = require('../../lib/flows/EvFlows');

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

// Day labels for learned profile settings keys (0=Monday)
const LEARNED_PROFILE_KEYS = [
  'learned_profile_mon', 'learned_profile_tue', 'learned_profile_wed',
  'learned_profile_thu', 'learned_profile_fri', 'learned_profile_sat', 'learned_profile_sun',
];

class CarChargeDevice extends GenericDevice {

  async initDeviceValues() {
    this.lastKnownSoc = await this.getStoreValue('lastKnownSoc') || 0;
    this.socForecastModel = await this.getStoreValue('socForecastModel') || EvDepartureStrategy.createModel();
    await super.initDeviceValues();
  }

  async onInit() {
    this.ds = deviceSpecifics;
    this.flows = new EvFlows(this);
    this.evDevice = null; // optional secondary car device
    this.sourceCapGroup = {};
    this.carCapGroup = {};
    this.isCarConnected = true; // optimistic default until we know otherwise
    await super.onInit().catch(this.error);

    const currentSessionId = this.sessionId;
    this.homey.setTimeout(async () => {
      await new Promise((resolve) => this.homey.setTimeout(resolve, 2000));
      if (this.sessionId !== currentSessionId) return;
      if (this.pricesNextHours) {
        await this.updateChargeChart().catch((err) => this.error(err));
      }
      // Bootstrap departure model from Insights history
      await this.learnDeparturePattern().catch((err) => this.error(err));
    }, 0);
  }

  // ─── Source device capability group resolution ──────────────────────────────

  async addSourceCapGroup() {
    this.sourceCapGroup = {};

    // --- Charger device (primary source = this.sourceDevice) ---
    if (this.sourceDevice) {
      const fallbackMeter = this.ds.cmap.meter_source;
      if (this.sourceDevice.capabilities.includes(fallbackMeter)) {
        this.sourceCapGroup.p1 = fallbackMeter;
      }
      if (this.sourceDevice.capabilities.includes('measure_power')) {
        this.sourceCapGroup.measure = 'measure_power';
      }
      if (this.sourceDevice.capabilities.includes('measure_battery')) {
        this.sourceCapGroup.socOnCharger = 'measure_battery';
      }
      // Connection state from charger
      if (this.sourceDevice.capabilities.includes('evcharger_charging_state')) {
        this.sourceCapGroup.connState = 'evcharger_charging_state';
      } else if (this.sourceDevice.capabilities.includes('evcharger_charging')) {
        this.sourceCapGroup.connStateBool = 'evcharger_charging';
      }
    }

    // --- Optional EV car device ---
    this.carCapGroup = {};
    let evDeviceId = this.getSettings().ev_device_id;

    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) {}
      if (api) {
        let ev = null;
        if (evDeviceId && evDeviceId !== 'none') {
          ev = await api.devices.getDevice({ id: evDeviceId, $cache: false }).catch(() => null);
        } else {
          // Auto-discover car device in Homey
          const allDevs = await api.devices.getDevices({ $cache: false }).catch(() => ({}));
          const carDev = Object.values(allDevs || {}).find((d) => (
            d.class === 'car' || d.virtualClass === 'car'
          ));
          if (carDev) {
            ev = carDev;
            evDeviceId = carDev.id;
            await this.setSettings({ ev_device_id: carDev.id, ev_device_name: carDev.name }).catch(() => {});
          }
        }

        if (ev && ev.capabilitiesObj) {
          this.evDevice = ev;
          const evCaps = ev.capabilities || [];
          if (evCaps.includes('measure_battery')) this.carCapGroup.soc = 'measure_battery';
          if (evCaps.includes('evcharger_charging_state')) {
            this.carCapGroup.connState = 'evcharger_charging_state';
          } else if (evCaps.includes('evcharger_charging')) {
            this.carCapGroup.connStateBool = 'evcharger_charging';
          }
          this.log(`EV car device linked: ${ev.name}`);
        }
      }
    } catch (e) {
      this.log('Could not load EV car device:', e.message);
    }

    // Resolve effective SoC source: prefer car, fall back to charger
    this.sourceCapGroup.soc = this.carCapGroup.soc || this.sourceCapGroup.socOnCharger || null;

    if (!this.sourceCapGroup.p1 && !this.sourceCapGroup.measure) {
      throw Error('Charger device has no compatible meter_power or measure_power');
    }
  }

  // ─── Real-time listeners ────────────────────────────────────────────────────

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {}
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();
    await this.addSourceCapGroup();

    this.log(`Registering listeners for charger: ${this.sourceDevice.name}`);

    // kWh meter
    if (this.sourceCapGroup.p1) {
      this.capabilityInstances.p1 = this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.p1,
        async (value) => this.updateMeter(value).catch(this.error),
      );
    }

    // Instantaneous power
    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure) {
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance(
        'measure_power',
        async (value) => {
          if (typeof value === 'number') {
            if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
            if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(-value).catch(this.error);
          }
        },
      );
    }

    // Connection state from charger
    if (this.sourceCapGroup.connState) {
      this.capabilityInstances.chargerConnState = await this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.connState,
        async (value) => this._handleConnectionState(value, 'charger'),
      );
    } else if (this.sourceCapGroup.connStateBool) {
      this.capabilityInstances.chargerConnBool = await this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.connStateBool,
        async (value) => this._handleConnectionState(value ? 'charging' : 'disconnected', 'charger'),
      );
    }

    // SoC from charger (when no car device)
    if (this.sourceCapGroup.socOnCharger && !this.evDevice) {
      this.capabilityInstances.socRealtime = await this.sourceDevice.makeCapabilityInstance(
        'measure_battery',
        async (value) => this._handleSocUpdate(value),
      );
    }

    // EV car device listeners
    if (this.evDevice) {
      this.log(`Registering listeners for EV car: ${this.evDevice.name}`);

      if (this.carCapGroup.soc) {
        this.capabilityInstances.carSocRealtime = await this.evDevice.makeCapabilityInstance(
          'measure_battery',
          async (value) => this._handleSocUpdate(value),
        );
      }

      if (this.carCapGroup.connState) {
        this.capabilityInstances.carConnState = await this.evDevice.makeCapabilityInstance(
          this.carCapGroup.connState,
          async (value) => this._handleConnectionState(value, 'car'),
        );
      } else if (this.carCapGroup.connStateBool) {
        this.capabilityInstances.carConnBool = await this.evDevice.makeCapabilityInstance(
          this.carCapGroup.connStateBool,
          async (value) => this._handleConnectionState(value ? 'charging' : 'disconnected', 'car'),
        );
      }
    }
  }

  // ─── Connection state handler ───────────────────────────────────────────────

  async _handleConnectionState(stateValue, source) {
    const wasConnected = this.isCarConnected;
    const isNowConnected = stateValue !== 'disconnected' && stateValue !== false;

    this.log(`[EV Slot] Connection state update from ${source}: ${stateValue} (connected=${isNowConnected})`);

    if (wasConnected && !isNowConnected) {
      // --- DEPARTURE detected ---
      this.isCarConnected = false;
      await this._onDeparture();
    } else if (!wasConnected && isNowConnected) {
      // --- RETURN detected ---
      this.isCarConnected = true;
      await this._onReturn();
    }
  }

  async _onDeparture() {
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const depFh = EvDepartureStrategy.toLocalFractionalHour(now, tz);
    const depSoc = typeof this.lastKnownSoc === 'number' ? this.lastKnownSoc : null;
    const batCap = this.getSettings().batCapacity || 50;

    this.log(`[EV Slot] Departure recorded at ${EvDepartureStrategy.fractionalHourToHHMM(depFh)} with SoC ${depSoc !== null ? `${depSoc}%` : 'unknown'}`);

    if (this.getSettings().autoDepartureLearning !== false) {
      EvDepartureStrategy.recordDeparture(this.socForecastModel, dow, depFh, depSoc, batCap);
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
    }

    // Suspend: chart preserved but isCarConnected=false so plan is shown as prediction
    await this.updateChargeChart().catch(this.error);
  }

  async _onReturn() {
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const retFh = EvDepartureStrategy.toLocalFractionalHour(now, tz);

    // Read live SoC at moment of return (most accurate)
    const liveSoc = await this._readLiveSoc();
    if (liveSoc !== null) {
      this.lastKnownSoc = liveSoc;
      await this.setStoreValue('lastKnownSoc', liveSoc).catch(this.error);
    }

    this.log(`[EV Slot] Return recorded at ${EvDepartureStrategy.fractionalHourToHHMM(retFh)} with SoC ${liveSoc !== null ? `${liveSoc}%` : 'unknown'}`);

    if (this.getSettings().autoDepartureLearning !== false) {
      EvDepartureStrategy.recordReturn(this.socForecastModel, dow, retFh, liveSoc);
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
    }

    // Immediately recalculate with fresh live SoC
    await this.updateChargeChart().catch(this.error);
  }

  // ─── SoC update handler ─────────────────────────────────────────────────────

  async _handleSocUpdate(value) {
    if (typeof value !== 'number') return;

    const oldSoc = this.lastKnownSoc !== undefined ? this.lastKnownSoc : value;
    this.lastKnownSoc = value;
    this.setStoreValue('lastKnownSoc', value).catch(this.error);

    const referenceSoc = this.lastRecalculatedSoc !== undefined ? this.lastRecalculatedSoc : oldSoc;
    if (Math.abs(value - referenceSoc) >= 2) {
      this.lastRecalculatedSoc = value;
      this.log(`EV SoC changed to ${value}%, recalculating strategy...`);
      if (this.socUpdateTimeout) this.homey.clearTimeout(this.socUpdateTimeout);
      this.socUpdateTimeout = this.homey.setTimeout(() => {
        this.updateChargeChart().catch(this.error);
      }, 5000);
    }
  }

  async _readLiveSoc() {
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) {}

      // Prefer car device SoC
      if (this.evDevice && this.carCapGroup.soc && api) {
        const dev = await api.devices.getDevice({ id: this.evDevice.id, $cache: false }).catch(() => null);
        if (dev && dev.capabilitiesObj && dev.capabilitiesObj.measure_battery) {
          return dev.capabilitiesObj.measure_battery.value;
        }
      }
      // Fallback: charger device SoC
      if (this.sourceDevice && this.sourceCapGroup.socOnCharger) {
        await this.getSourceDevice();
        const val = this.sourceDevice.capabilitiesObj?.measure_battery?.value;
        if (typeof val === 'number') return val;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ─── Poll (hourly) ──────────────────────────────────────────────────────────

  async poll() {
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) {
      return;
    }
    if (!api) return;

    if (!this.sourceCapGroup || Object.keys(this.sourceCapGroup).length === 0) await this.addSourceCapGroup();
    await this.getSourceDevice();

    // kWh meter
    if (this.sourceCapGroup.p1 && this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.p1]) {
      const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup.p1].value;
      await this.updateMeter(val).catch(this.error);
    }

    // Instantaneous power
    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure && this.sourceDevice.capabilitiesObj?.measure_power) {
      const rtValue = this.sourceDevice.capabilitiesObj.measure_power.value;
      if (typeof rtValue === 'number') {
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(-rtValue).catch(this.error);
      }
    }

    // SoC poll
    const liveSoc = await this._readLiveSoc();
    if (liveSoc !== null) await this._handleSocUpdate(liveSoc);
  }

  // ─── Settings change handler ────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    await super.onSettings({ newSettings, changedKeys });
    const strategyKeys = [
      'chargePower', 'batCapacity', 'targetSoc', 'variableChargePower',
      'departureTime_0', 'departureTime_1', 'departureTime_2', 'departureTime_3',
      'departureTime_4', 'departureTime_5', 'departureTime_6',
    ];
    if (changedKeys.some((k) => strategyKeys.includes(k))) {
      this.updateChargeChart().catch(this.error);
    }
    return true;
  }

  async onPricesUpdated() {
    await this.updateChargeChart().catch(this.error);
  }

  async handleUpdateMeter(reading) {
    await super.handleUpdateMeter(reading);
    const now = new Date(reading.meterTm);
    const currentSlot = (now.getUTCHours() * (60 / (this.priceInterval || 60)))
      + Math.floor(now.getUTCMinutes() / (this.priceInterval || 60));
    if (this.lastEvTriggerSlot !== currentSlot) {
      this.lastEvTriggerSlot = currentSlot;
      await this.updateChargeChart().catch(this.error);
    }
  }

  // ─── Resolve departure time for today ──────────────────────────────────────

  _getEffectiveDepartureTime() {
    const settings = this.getSettings();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const now = new Date();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const manualTimes = [0, 1, 2, 3, 4, 5, 6].map((i) => settings[`departureTime_${i}`] || '');
    return EvDepartureStrategy.getEffectiveDepartureTime(
      this.socForecastModel,
      dow,
      manualTimes,
      '08:00',
    );
  }

  // ─── Main charge chart update ───────────────────────────────────────────────

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    this.log('updating EV charge chart', this.getName(), `(connected=${this.isCarConnected})`);

    const settings = this.getSettings();
    const chargePower = settings.chargePower || 11000;
    const batCapacity = settings.batCapacity || 50;
    const tz = this.timeZone || this.homey.clock.getTimezone();

    // Determine current SoC:
    // - If car is connected: use live SoC (accurate)
    // - If car is absent: use predicted return SoC for today's day-of-week
    let currentSoc;
    if (this.isCarConnected) {
      const liveSoc = await this._readLiveSoc();
      currentSoc = liveSoc !== null ? liveSoc : (this.lastKnownSoc || 0);
    } else {
      const dow = EvDepartureStrategy.getDowLocal(new Date(), tz);
      const predicted = EvDepartureStrategy.getPredictedReturnSoc(this.socForecastModel, dow);
      currentSoc = predicted !== null ? predicted : (this.lastKnownSoc || 0);
      this.log(`[EV Slot] Car absent — using predicted return SoC: ${currentSoc}%`);
    }
    this.lastKnownSoc = currentSoc;

    const departureTime = this._getEffectiveDepartureTime();
    this.log(`[EV Slot] Effective departure time: ${departureTime}`);

    const strategy = EvChargeStrategy.getStrategy({
      prices: this.pricesNextHours,
      priceInterval: this.priceInterval,
      chargePower,
      currentSoc,
      targetSoc: settings.targetSoc || 100,
      batCapacity,
      departureTime,
      timezone: tz,
      variableChargePower: settings.variableChargePower || false,
    });

    if (strategy) {
      if (typeof this.flows.triggerNewEvStrategyFlow === 'function') {
        await this.flows.triggerNewEvStrategyFlow(strategy).catch(this.error);
      }

      if (this.pricesNextHoursIsForecast) {
        Object.keys(strategy).forEach((k) => {
          if (this.pricesNextHoursIsForecast[k]) strategy[k].isForecast = true;
        });
      }

      // If car is not connected, mark all strategy slots as forecast (grey)
      if (!this.isCarConnected) {
        Object.keys(strategy).forEach((k) => {
          if (strategy[k] && typeof strategy[k] === 'object') strategy[k].isForecast = true;
        });
      }

      const now = new Date();
      now.setMilliseconds(0);
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const H0 = nowLocal.getHours();
      const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;

      const chartNextHours = await getChargeChart(
        { scheme: JSON.stringify(strategy) },
        H0 + (M0 / 60),
        this.pricesNextHoursMarketLength,
        chargePower,
        0,
        this.priceInterval,
        null,
      );

      this.chartNextHoursCharge = chartNextHours;
      if (!this.nextHoursChargeImage) {
        this.nextHoursChargeImage = await this.homey.images.createImage();
        this.nextHoursChargeImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursCharge, stream, this));
        await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
      }
      await this.nextHoursChargeImage.update().catch(this.error);
    }
  }

  // ─── Batch departure pattern learning from Insights ────────────────────────

  async learnDeparturePattern() {
    this.log('[EV Slot] Starting departure pattern learning from Insights...');
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) {}
      if (!api) {
        this.log('[EV Slot] Homey API not ready for Insights learning.');
        return;
      }

      const allLogs = await api.insights.getLogs().catch(() => []);
      const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);

      const chargerId = this.getSettings().homey_device_id;
      const evId = this.getSettings().ev_device_id;
      const batCap = this.getSettings().batCapacity || 50;
      const tz = this.timeZone || this.homey.clock.getTimezone();

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 42 * 24 * 60 * 60 * 1000); // 6 weeks

      const fetchLog = async (deviceId, capNames) => {
        if (!deviceId || deviceId === 'none') return null;
        for (const capName of capNames) {
          const log = logs.find((l) => {
            const id = l.id || l.uri || '';
            return id.includes(deviceId) && (id.endsWith(`:${capName}`) || l.name === capName);
          });
          if (log) {
            this.log(`[EV Slot] Found Insights log: ${log.id || log.uri || log.name}`);
            for (const resStr of ['last31Days', 'last14Days', 'last7Days']) {
              const data = await api.insights.getLogEntries({
                id: log.id,
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                resolution: resStr,
              }).catch(() => null);
              if (data && data.values && data.values.length > 0) {
                this.log(`[EV Slot] Retrieved ${data.values.length} entries from ${log.name || log.id} (res=${resStr})`);

                const isCumulative = capName.includes('meter') || capName.includes('energy');
                if (isCumulative && data.values.length > 1) {
                  const powerWatts = [];
                  for (let i = 1; i < data.values.length; i++) {
                    const prev = data.values[i - 1];
                    const curr = data.values[i];
                    const getVal = (item) => {
                      if (typeof item.v === 'number') return item.v;
                      if (typeof item.y === 'number') return item.y;
                      return 0;
                    };
                    const prevV = getVal(prev);
                    const currV = getVal(curr);
                    const prevT = new Date(prev.t).getTime();
                    const currT = new Date(curr.t).getTime();
                    const dtHours = (currT - prevT) / (3600 * 1000);
                    const dKwh = currV - prevV;
                    if (dtHours > 0 && dKwh >= 0 && dKwh < 500) {
                      const watts = (dKwh / dtHours) * 1000;
                      powerWatts.push({ t: currT, v: watts });
                    }
                  }
                  this.log(`[EV Slot] Converted ${powerWatts.length} cumulative entries to power (Watts)`);
                  return powerWatts;
                }

                return data.values.map((e) => {
                  let val = 0;
                  if (typeof e.v === 'number') val = e.v;
                  else if (typeof e.y === 'number') val = e.y;
                  return { t: new Date(e.t).getTime(), v: val };
                });
              }
            }
          }
        }
        return null;
      };

      // Fetch charger power entries for session boundary detection
      const powerEntries = await fetchLog(chargerId, ['measure_power', 'meter_power', 'energy_power']);

      // Fetch SoC entries from car device if available
      let socEntries = null;
      if (evId && evId !== 'none') {
        socEntries = await fetchLog(evId, ['measure_battery']);
      }

      if (!powerEntries || powerEntries.length < 2) {
        this.log('[EV Slot] No power history found in Insights for charger.');
        return;
      }

      this.socForecastModel = EvDepartureStrategy.bootstrapFromHistory(
        powerEntries, socEntries, tz, batCap,
      );
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
      this.log('[EV Slot] Departure learning complete. Model updated from history.');
    } catch (err) {
      this.error('[EV Slot] learnDeparturePattern failed:', err);
    }
  }

  // ─── Update learned profile display in settings ─────────────────────────────

  async _updateLearnedProfileSettings() {
    try {
      const profileUpdate = {};
      for (let dow = 0; dow < 7; dow++) {
        const day = this.socForecastModel[dow];
        const key = LEARNED_PROFILE_KEYS[dow];
        if (!day || day.sessionCount === 0) {
          profileUpdate[key] = 'not yet learned';
        } else {
          const dep = day.learnedDepartureTime || '?';
          const ret = day.learnedReturnTime || '?';
          const depSoc = day.learnedDepartureSoc !== null ? `${day.learnedDepartureSoc}%` : '?';
          const retSoc = day.learnedReturnSoc !== null ? `${day.learnedReturnSoc}%` : '?';
          const trip = day.learnedTripKwh !== null ? `${day.learnedTripKwh}kWh` : '?';
          profileUpdate[key] = `dep ${dep} SoC${depSoc} / ret ${ret} SoC${retSoc} trip${trip} (n=${day.sessionCount})`;
        }
      }
      await this.setSettings(profileUpdate).catch(this.error);
    } catch (e) {
      this.error('_updateLearnedProfileSettings failed:', e);
    }
  }
}

module.exports = CarChargeDevice;
