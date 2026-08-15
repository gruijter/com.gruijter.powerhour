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
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const DeviceMigrator = require('../../lib/DeviceMigrator');

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
    await super.onInit().catch(this.error);

    for (const cap of ['ev_charge_mode', 'ev_next_departure', 'ev_target_soc', 'ev_departure_time', 'button.retrain']) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability ${cap} to device ${this.getName()}`);
        await this.addCapability(cap).catch(this.error);
      }
    }

    this.powerHistory = (await this.getStoreValue('powerHistory')) || [];
    this.socHistory = (await this.getStoreValue('socHistory')) || [];

    // One-time fix for chart display order: today, tomorrow, next hours, yesterday.
    await DeviceMigrator.migrateImageCapabilityOrder(this, {
      todayChargeChart: 'todayChargeImage',
      tomorrowChargeChart: 'tomorrowChargeImage',
      nextHoursChargeChart: 'nextHoursChargeImage',
      yesterdayChargeChart: 'yesterdayChargeImage',
    }, 'chartOrderMigrated_v1');

    if (this.hasCapability('ev_charge_mode')) {
      if (!this.getCapabilityValue('ev_charge_mode')) {
        await this.setCapabilityValue('ev_charge_mode', 'scheduled_price').catch(this.error);
      }
      this.registerCapabilityListener('ev_charge_mode', async (value) => {
        this.log(`EV charge mode set to ${value}`);
        if (this.homey.app.trigger_ev_charge_mode_changed) {
          await this.homey.app.trigger_ev_charge_mode_changed(this, { mode: value }, {}).catch(this.error);
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('ev_target_soc')) {
      this.registerCapabilityListener('ev_target_soc', async (value) => {
        const numVal = Number(value) || 80;
        this.log(`EV target SoC UI picker changed to ${numVal}%`);
        const tripOverride = this.getStoreValue('tripOverride');
        if (tripOverride) {
          tripOverride.targetSoc = numVal;
          await this.setStoreValue('tripOverride', tripOverride);
        } else {
          await this.setSettings({ targetSoc: numVal }).catch(this.error);
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('ev_departure_time')) {
      this.registerCapabilityListener('ev_departure_time', async (value) => {
        this.log(`EV departure time UI picker changed to ${value}`);
        if (value === 'until_next_schedule') {
          await this.setStoreValue('tripOverride', null);
          this.log('Cleared trip override via UI picker');
        } else if (value === 'indefinite') {
          const tripOverride = this.getStoreValue('tripOverride') || {};
          tripOverride.departureTime = 'indefinite';
          await this.setStoreValue('tripOverride', tripOverride);
        } else {
          const tripOverride = this.getStoreValue('tripOverride');
          if (tripOverride) {
            tripOverride.departureTime = value;
            await this.setStoreValue('tripOverride', tripOverride);
          } else {
            await this.setSettings({ departureTime: value }).catch(this.error);
          }
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('button.retrain')) {
      this.retrainListener = this.registerCapabilityListener('button.retrain', async () => {
        this.log('[EV Slot] Manual retrain triggered via button.retrain');
        await this.learnDeparturePattern(); // Fully overwrites socForecastModel from scratch
        return true;
      });
    }

    const currentSessionId = this.sessionId;
    this.homey.setTimeout(async () => {
      await new Promise((resolve) => this.homey.setTimeout(resolve, 2000));
      if (this.sessionId !== currentSessionId) return;
      if (this.pricesNextHours) {
        await this.updateChargeChart().catch((err) => this.error(err));
      }
      // Bootstrap departure model from Insights history
      await this.attemptInitialBackfill(currentSessionId);
    }, 0);
  }

  // learnDeparturePattern() needs this.homey.app.api to be connected - but app.js can still be
  // mid-connect (up to a 10s timeout, then only a 60s-later retry) when this fires only ~2s
  // after onInit. learnDeparturePattern() itself treats "API not ready" as a logged no-op
  // rather than throwing, so retry here by re-checking API readiness directly instead of
  // catching an error. Unlike grid/solar (see identical fix in those drivers' device.js),
  // there's no nightly retrain safety net for the departure model, so a failed bootstrap here
  // would otherwise stick until the next full app/device restart. Guarded by sessionId (the
  // same guard already used above) rather than an explicit timeout handle, since this file
  // doesn't currently track/clear its init timers on delete.
  async attemptInitialBackfill(sessionId, attempt = 1) {
    if (this.sessionId !== sessionId) return; // superseded by a newer onInit/delete meanwhile
    const maxAttempts = 5;
    const retryDelayMs = 30000;
    let api;
    try {
      api = this.homey.app.api;
    } catch (e) { }
    if (!api) {
      if (attempt >= maxAttempts) {
        this.error(`[attemptInitialBackfill] Homey API still not ready after ${maxAttempts} attempts, `
          + 'giving up. Departure model will stay unlearned until the next app/device restart.');
        return;
      }
      this.log(`[attemptInitialBackfill] Homey API not ready yet (attempt ${attempt}/${maxAttempts}), `
        + `retrying in ${retryDelayMs / 1000}s...`);
      this.homey.setTimeout(() => this.attemptInitialBackfill(sessionId, attempt + 1), retryDelayMs);
      return;
    }
    await this.learnDeparturePattern().catch((err) => this.error(err));
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
    // No auto-discovery: 'none' means the user did not link a car at pair/repair time.
    // They can attach one later via repair.
    this.carCapGroup = {};
    const evDeviceId = this.getSettings().ev_device_id;

    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) { }
      if (api && evDeviceId && evDeviceId !== 'none') {
        const ev = await api.devices.getDevice({ id: evDeviceId, $cache: false }).catch(() => null);

        if (ev && ev.capabilitiesObj) {
          this.evDevice = ev;
          const evCaps = ev.capabilities || [];
          if (evCaps.includes('measure_battery')) this.carCapGroup.soc = 'measure_battery';
          // 'ev_charging_state' is Homey's standard charging-state capability for car/vehicle-class
          // devices (e.g. this developer's own com.kia_hyundai app) - 'evcharger_charging_state' is
          // the equivalent for evcharger-class devices. Both share the identical enum
          // (plugged_in_charging/plugged_in_discharging/plugged_in_paused/plugged_in/plugged_out).
          // NOT used directly for departure/return detection on its own - it only says the car is
          // plugged in SOMEWHERE (home, work, a public station), not specifically at THIS charger.
          // Instead it feeds this.carPluggedIn, a tracked flag combined with the charger's own
          // power in the power-gap fallback below: charger power alone can't tell our car apart
          // from a different car charging at the same monitored charger, and the car's own state
          // alone can't tell "at this charger" apart from "charging elsewhere" - requiring BOTH to
          // agree resolves both ambiguities at once.
          if (evCaps.includes('evcharger_charging_state')) {
            this.carCapGroup.connState = 'evcharger_charging_state';
          } else if (evCaps.includes('ev_charging_state')) {
            this.carCapGroup.connState = 'ev_charging_state';
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
    } catch (e) { }
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
            // measure_power on an EV charger follows Homey's standard (positive = charging the
            // car); updateMeterFromMeasure() internally re-writes measure_watt_avg with whatever
            // sign it's given (overwriting the setCapability above) and also buckets kWh into
            // meter_kwh_charging/discharging based on this same sign, so it must not be negated.
            if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
            if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(value).catch(this.error);
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

      // Tracks whether the linked car reports itself plugged in ANYWHERE, not specifically at
      // this charger - see the power-gap fallback in handleUpdateMeter() for how this is
      // combined with the charger's own power to resolve that ambiguity.
      if (this.carCapGroup.connState) {
        this.capabilityInstances.carConnState = await this.evDevice.makeCapabilityInstance(
          this.carCapGroup.connState,
          async (value) => this._handleCarPluggedInSignal(value),
        );
      } else if (this.carCapGroup.connStateBool) {
        this.capabilityInstances.carConnBool = await this.evDevice.makeCapabilityInstance(
          this.carCapGroup.connStateBool,
          async (value) => this._handleCarPluggedInSignal(value ? 'charging' : 'disconnected'),
        );
      }
    }
  }

  // ─── Connection state handler ───────────────────────────────────────────────

  // 'disconnected' is only ever synthesized by this file itself (the boolean-capability
  // fallback, e.g. evcharger_charging: false -> 'disconnected', and the power-gap fallback
  // below). The REAL "not connected" value for Homey's enum charging-state capabilities
  // (evcharger_charging_state, ev_charging_state - confirmed identical enum for both) is
  // 'plugged_out', which used to go unrecognized here - a genuine disconnect on the enum path
  // was silently never detected.
  _isConnectedStateValue(stateValue) {
    return stateValue !== 'disconnected' && stateValue !== 'plugged_out' && stateValue !== false;
  }

  async _handleConnectionState(stateValue, source) {
    const wasConnected = this.isCarConnected;
    const isNowConnected = this._isConnectedStateValue(stateValue);

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

  // Tracks the linked car's own plug state (plugged in SOMEWHERE, not specifically at this
  // charger) without itself firing a departure/return - see _checkPowerGapConnectionState().
  _handleCarPluggedInSignal(stateValue) {
    this.carPluggedIn = this._isConnectedStateValue(stateValue);
  }

  // Live departure/return fallback for chargers with no connection-state capability of their
  // own (e.g. a plain smart plug tagged as an EV charger - confirmed the common case: this
  // driver's own compatibility check accepts 'socket'/'other'/'heater' class devices with just
  // measure_power). Mirrors EvDepartureStrategy.bootstrapFromHistory()'s one-time Insights
  // backfill heuristic (same ACTIVE_POWER_THRESHOLD/SESSION_GAP_MS), run continuously instead.
  //
  // Charger power alone can't tell "our car" apart from a different car charging at the same
  // monitored charger; the car's own plug state alone can't tell "at this charger" apart from
  // "charging elsewhere". Requiring both to agree (when the car's own signal is available)
  // resolves both ambiguities - see addSourceCapGroup()'s carCapGroup.connState comment.
  _checkPowerGapConnectionState(power, timestamp) {
    const chargerActive = power > EvDepartureStrategy.ACTIVE_POWER_THRESHOLD;
    const carSignalKnown = typeof this.carPluggedIn === 'boolean';
    const isActive = chargerActive && (!carSignalKnown || this.carPluggedIn);

    if (isActive) {
      this.lastActivePowerGapTm = timestamp;
      if (this.powerGapDepartureDeclared) {
        this.powerGapDepartureDeclared = false;
        this._handleConnectionState('charging', 'charger-power-gap').catch(this.error);
      }
      return;
    }

    if (!this.powerGapDepartureDeclared && this.lastActivePowerGapTm
      && (timestamp - this.lastActivePowerGapTm) > EvDepartureStrategy.SESSION_GAP_MS) {
      this.powerGapDepartureDeclared = true;
      this._handleConnectionState('plugged_out', 'charger-power-gap').catch(this.error);
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

    // Same dedup/cap approach as powerHistory in handleUpdateMeter(): at most one sample
    // per minute, capped to 2880 entries (48h), so getActualSocForTime() has real data for
    // the yesterday/today charts instead of the flat "current SoC everywhere" placeholder.
    // lastKnownSoc only needs to survive a restart, not be durable to the second, so its store
    // write rides along on this same once-a-minute gate instead of firing on every realtime push.
    const currentTimestamp = Date.now();
    if (!Array.isArray(this.socHistory)) this.socHistory = [];
    const lastSocEntry = this.socHistory[this.socHistory.length - 1];
    if (!lastSocEntry || Math.abs(currentTimestamp - lastSocEntry.time) >= 60000) {
      this.socHistory.push({ time: currentTimestamp, soc: value });
      if (this.socHistory.length > 2880) this.socHistory.shift();
      this.setStoreValue('socHistory', this.socHistory).catch(this.error);
      this.setStoreValue('lastKnownSoc', value).catch(this.error);
    }

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
      } catch (e) { }

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
        // See addListeners() for why this must not be negated (Homey standard: charging = positive).
        if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(rtValue).catch(this.error);
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
    this.pricesUpdated = true;
    await this.updateChargeChart().catch(this.error);
  }

  async handleUpdateMeter(reading) {
    // This override previously shadowed GenericDevice#handleUpdateMeter entirely (same method
    // name), silently skipping the base class's meter-period bookkeeping (meter_power_hidden,
    // lastReadingHour/Day/Month/Year) and money calculation (meter_money_*) since the "graphs
    // upgrade" commit that introduced this override. Restore the base behaviour.
    await super.handleUpdateMeter(reading);

    // Neither this device nor the HomeyAPI sourceDevice wrapper expose a 'measure_power'
    // capability/method, so that lookup always failed. The device's own live charge
    // power is published on 'measure_watt_avg'.
    let livePower = (reading && typeof reading.measure_power === 'number') ? reading.measure_power : null;
    if (livePower === null && this.hasCapability('measure_watt_avg')) {
      livePower = this.getCapabilityValue('measure_watt_avg');
    }
    if (typeof livePower !== 'number') livePower = 0;

    const currentTimestamp = (reading && reading.meterTm) ? new Date(reading.meterTm).getTime() : Date.now();
    if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
    const lastEntry = this.powerHistory[this.powerHistory.length - 1];
    if (!lastEntry || Math.abs(currentTimestamp - lastEntry.time) >= 60000) {
      this.powerHistory.push({ time: currentTimestamp, power: livePower });
      if (this.powerHistory.length > 2880) this.powerHistory.shift();
      if (!this.lastPowerHistorySaveTm || (currentTimestamp - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.lastPowerHistorySaveTm = currentTimestamp;
      }
    }

    // Only needed when the charger has no connection-state capability of its own - when it
    // does (a real wallbox), that's already the location-accurate signal driving
    // _handleConnectionState() directly (see addListeners()).
    if (!this.sourceCapGroup.connState && !this.sourceCapGroup.connStateBool) {
      this._checkPowerGapConnectionState(livePower, currentTimestamp);
    }

    if (livePower > 500) {
      const storedMax = (await this.getStoreValue('detectedMaxPower')) || 0;
      if (livePower > storedMax) {
        const roundedMax = Math.round(livePower / 100) * 100;
        await this.setStoreValue('detectedMaxPower', roundedMax);
        this.log(`[EV Power Auto-Detect] New peak power detected! Updated stored peak from ${storedMax} W to ${roundedMax} W`);
        await this.setSettings({ chargePower: roundedMax }).catch(this.error);
        this.updateChargeChart().catch(this.error);
      }
    }

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
    const detectedPower = (await this.getStoreValue('detectedMaxPower')) || null;
    const manualPower = Number(settings.chargePower) || 0;
    const chargePower = (detectedPower && detectedPower > manualPower) ? detectedPower : (manualPower || 3700);
    this.log(`[EV Slot] Resolved charge power: ${chargePower} W (manual setting=${settings.chargePower}, auto-detected=${detectedPower})`);
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

    const tripOverride = this.getStoreValue('tripOverride') || null;
    const effectiveDepartureTime = tripOverride ? tripOverride.departureTime : this._getEffectiveDepartureTime();
    const effectiveTargetSoc = tripOverride ? tripOverride.targetSoc : (settings.targetSoc || 100);
    const chargeMode = this.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    this.log(`[EV Slot] Effective departure time: ${effectiveDepartureTime}, target SoC: ${effectiveTargetSoc}%, mode: ${chargeMode}`);

    if (this.hasCapability('ev_departure_time')) {
      await this.setCapabilityValue('ev_departure_time', String(effectiveDepartureTime)).catch(this.error);
    }
    if (this.hasCapability('ev_target_soc')) {
      await this.setCapabilityValue('ev_target_soc', String(effectiveTargetSoc)).catch(this.error);
    }
    if (this.hasCapability('ev_next_departure')) {
      let displayStr;
      if (effectiveDepartureTime === 'indefinite') {
        displayStr = `Onbepaald (${effectiveTargetSoc}%)`;
      } else {
        const tag = tripOverride ? 'Override' : 'Schedule';
        displayStr = `${tag}: ${effectiveDepartureTime} (${effectiveTargetSoc}%)`;
      }
      await this.setCapabilityValue('ev_next_departure', displayStr).catch(this.error);
    }

    const strategy = EvChargeStrategy.getStrategy({
      prices: this.pricesNextHours,
      exportPrices: this.exportPricesNextHours,
      priceInterval: this.priceInterval,
      chargePower,
      currentSoc,
      targetSoc: settings.targetSoc || 100,
      batCapacity,
      departureTime: effectiveDepartureTime,
      timezone: tz,
      variableChargePower: settings.variableChargePower || false,
      chargeMode,
      tripOverrideTime: tripOverride ? tripOverride.departureTime : null,
      tripOverrideSoc: tripOverride ? tripOverride.targetSoc : null,
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
      const slotsPerHour = 60 / this.priceInterval;
      const currentSlotInDay = Math.floor((H0 + (M0 / 60)) * slotsPerHour);
      const totalDaySlots = 24 * slotsPerHour;

      // Compute UTC-equivalent of local midnight: subtract local time components from current UTC time
      const todayStartMs = now.getTime()
        - (nowLocal.getHours() * 3600000)
        - (nowLocal.getMinutes() * 60000)
        - (nowLocal.getSeconds() * 1000)
        - nowLocal.getMilliseconds();
      const intervalMs = (this.priceInterval || 60) * 60 * 1000;

      await this.refreshDapPrices().catch(() => { });

      const currency = (this.getSettings() && this.getSettings().currency) || this.currency || (this.settings && this.settings.currency) || '€';
      const translations = {
        price: this.homey.__('price') || 'Prijs',
        power: this.homey.__('power') || 'Vermogen',
        soc: this.homey.__('soc') || 'SoC',
      };
      const showPower = !!this.getSettings().chartShowPower;
      // Force-disabled when neither the connected car nor the charger itself reports a real SoC
      // (this.sourceCapGroup.soc is resolved once per device start in addSourceCapGroup()) -
      // otherwise the chart would show a purely predicted/guessed SoC line with no way to tell.
      const showSoc = this.getSettings().chartShowSoc !== false && !!(this.sourceCapGroup && this.sourceCapGroup.soc);
      const showExportPrice = this.getSettings().chartShowExportPrice !== false;

      // 1. Image 1: Today (00:00 to 23:59 Today)
      const todayStrategy = {};
      const todayDateStr = nowLocal.toDateString();
      const todayExportPrices = [];
      await this.recordPlannedSchedule(strategy, currentSlotInDay, totalDaySlots, todayDateStr);

      for (let i = 0; i < totalDaySlots; i += 1) {
        const slotStartMs = todayStartMs + (i * intervalMs);
        const isPastOrPresent = slotStartMs <= now.getTime();
        let actualP = this.getActualPowerForTime(slotStartMs);
        if (isPastOrPresent && actualP === null) actualP = 0;
        const slotPrice = this.getPriceForTimestamp(slotStartMs);
        todayExportPrices[i] = this.getExportPriceForTimestamp(slotStartMs);

        if (i < currentSlotInDay) {
          const planned = this.getPlannedScheduleForSlot(i);
          const actualSoc = this.getActualSocForTime(slotStartMs);
          todayStrategy[i] = {
            power: planned.power,
            actualPower: actualP,
            duration: planned.duration,
            // Fall back to the live current SoC if no historical sample exists yet for this
            // slot (e.g. right after pairing, before socHistory has built up any data).
            soc: actualSoc !== null ? actualSoc : currentSoc,
            price: slotPrice,
            isForecast: false,
          };
        } else {
          const stratIdx = i - currentSlotInDay;
          if (strategy && strategy[stratIdx]) {
            todayStrategy[i] = {
              ...strategy[stratIdx],
              actualPower: isPastOrPresent ? actualP : (strategy[stratIdx].actualPower || null),
              // strategy's own isForecast flag reflects whether the *price* for that slot is
              // forecasted, not whether the slot itself has actually happened yet. A slot that
              // hasn't occurred must always render as planned/forecast, regardless of price origin.
              isForecast: isPastOrPresent ? !!strategy[stratIdx].isForecast : true,
            };
          } else {
            todayStrategy[i] = {
              power: 0,
              actualPower: isPastOrPresent ? actualP : null,
              duration: 0,
              soc: currentSoc,
              price: slotPrice,
              isForecast: true,
            };
          }
        }
      }

      const chartToday = await getChargeChart(
        { scheme: JSON.stringify(todayStrategy) },
        0,
        totalDaySlots,
        chargePower,
        0,
        this.priceInterval,
        todayExportPrices,
        currency,
        translations,
        true,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
      );

      this.chartTodayCharge = chartToday;
      if (!this.todayChargeImage) {
        this.todayChargeImage = await this.homey.images.createImage();
        this.todayChargeImage.setStream(async (stream) => imageUrlToStream(this.chartTodayCharge, stream, this));
        await this.setCameraImage('todayChargeChart', ` ${this.homey.__('today')}`, this.todayChargeImage);
      }
      await this.todayChargeImage.update().catch(this.error);

      // 2. Image 2: Tomorrow (00:00 to 23:59 Tomorrow) - only rebuild on date rollover, price change, or initial render
      const dateRolledOver = !this.lastRenderedDateStr || (this.lastRenderedDateStr !== todayDateStr);
      this.lastRenderedDateStr = todayDateStr;

      if (dateRolledOver || this.pricesUpdated || !this.tomorrowChargeImage) {
        const tomorrowStrategy = {};
        const remainingTodaySlots = totalDaySlots - currentSlotInDay;
        const tomorrowStartMs = todayStartMs + (24 * 60 * 60 * 1000);
        const tomorrowExportPrices = [];

        for (let i = 0; i < totalDaySlots; i += 1) {
          const stratIdx = remainingTodaySlots + i;
          if (strategy && strategy[stratIdx]) {
            tomorrowStrategy[i] = strategy[stratIdx];
          } else {
            tomorrowStrategy[i] = {
              power: 0,
              duration: 0,
              soc: null,
              price: null,
              isForecast: true,
            };
          }
          tomorrowExportPrices[i] = this.getExportPriceForTimestamp(tomorrowStartMs + (i * intervalMs));
        }

        const chartTomorrow = await getChargeChart(
          { scheme: JSON.stringify(tomorrowStrategy) },
          0,
          totalDaySlots,
          chargePower,
          0,
          this.priceInterval,
          tomorrowExportPrices,
          currency,
          translations,
          false,
          this.timeZone,
          showPower,
          showSoc,
          showExportPrice,
        );

        this.chartTomorrowCharge = chartTomorrow;
        if (!this.tomorrowChargeImage) {
          this.tomorrowChargeImage = await this.homey.images.createImage();
          this.tomorrowChargeImage.setStream(async (stream) => imageUrlToStream(this.chartTomorrowCharge, stream, this));
          await this.setCameraImage('tomorrowChargeChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowChargeImage);
        }
        await this.tomorrowChargeImage.update().catch(this.error);
      }

      // 3. Image 3: Next Hours (Rolling Window starting from current hour H0)
      const chartNextHours = await getChargeChart(
        { scheme: JSON.stringify(strategy) },
        H0 + (M0 / 60),
        this.pricesNextHoursMarketLength,
        chargePower,
        0,
        this.priceInterval,
        this.exportPricesNextHours,
        currency,
        translations,
        false,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
      );

      this.chartNextHoursCharge = chartNextHours;
      if (!this.nextHoursChargeImage) {
        this.nextHoursChargeImage = await this.homey.images.createImage();
        this.nextHoursChargeImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursCharge, stream, this));
        await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
      }
      await this.nextHoursChargeImage.update().catch(this.error);

      // 4. Image 4: Yesterday (00:00 to 23:59 Yesterday) - only rebuild on date rollover or initial render
      if (dateRolledOver || !this.yesterdayChargeImage) {
        const yesterdayStartMs = todayStartMs - (24 * 60 * 60 * 1000);
        const yesterdayStrategy = {};
        const yesterdayExportPrices = [];

        for (let i = 0; i < totalDaySlots; i += 1) {
          const slotStartMs = yesterdayStartMs + (i * intervalMs);
          let actualP = this.getActualPowerForTime(slotStartMs);
          if (actualP === null) actualP = 0;
          const slotPrice = this.getPriceForTimestamp(slotStartMs);
          const planned = this.getPlannedScheduleForSlot(i, true);
          yesterdayExportPrices[i] = this.getExportPriceForTimestamp(slotStartMs);

          yesterdayStrategy[i] = {
            power: planned.power,
            actualPower: actualP,
            duration: planned.duration,
            soc: this.getActualSocForTime(slotStartMs),
            price: slotPrice,
            isForecast: false,
          };
        }

        const chartYesterday = await getChargeChart(
          { scheme: JSON.stringify(yesterdayStrategy) },
          0,
          totalDaySlots,
          chargePower,
          0,
          this.priceInterval,
          yesterdayExportPrices,
          currency,
          translations,
          false,
          this.timeZone,
          showPower,
          showSoc,
          showExportPrice,
        );

        this.chartYesterdayCharge = chartYesterday;
        if (!this.yesterdayChargeImage) {
          this.yesterdayChargeImage = await this.homey.images.createImage();
          this.yesterdayChargeImage.setStream(async (stream) => imageUrlToStream(this.chartYesterdayCharge, stream, this));
          await this.setCameraImage('yesterdayChargeChart', ` ${this.homey.__('yesterday')}`, this.yesterdayChargeImage);
        }
        await this.yesterdayChargeImage.update().catch(this.error);
      }

      this.pricesUpdated = false;
    }
  }

  // ─── Batch departure pattern learning from Insights ────────────────────────

  async learnDeparturePattern() {
    this.log('[EV Slot] Starting departure pattern learning from Insights...');
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch (e) { }
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
          if (!log) continue;

          // On devices with energy-class registration, Homey stores the Insights log for
          // 'measure_power' itself under the internal log id 'energy_power' - same signal,
          // different log name, NOT a separate derived value and NOT cumulative despite the
          // name (confirmed empirically: same scale/sign as live measure_power).
          const isCumulative = capName.includes('meter') || (capName.includes('energy') && capName !== 'energy_power');

          const convert = (data, resStr) => {
            if (!data || !data.values || data.values.length === 0) return null;
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
                  powerWatts.push({ t: prevT, v: watts });
                }
              }
              return powerWatts;
            }

            // 'energy_power' AND 'measure_battery' (used here for the car's SoC) hourly entries
            // are already stamped at the START of the hour they represent (confirmed
            // empirically against a real device: both logs' raw hourly entry lined up exactly
            // with the real transition seen in Homey's own Insights graph, at the same raw
            // timestamp) - unlike other hourly logs, which are END-of-interval stamped and need
            // the -1h correction below.
            const startStampedCaps = ['energy_power', 'measure_battery'];
            const isHourly = (resStr === 'last7Days' || resStr === 'last14Days' || resStr === 'last31Days') && !startStampedCaps.includes(capName);
            return data.values.map((e) => {
              let val = 0;
              if (typeof e.v === 'number') val = e.v;
              else if (typeof e.y === 'number') val = e.y;
              const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
              const t = isHourly ? rawT - 3600000 : rawT;
              return { t, v: val };
            });
          };

          // Two-stage fetch, mirroring solar's approach (drivers/solar/device.js): a single
          // 'last7Days'/'last14Days'/'last31Days' fetch only ever returns HOURLY points, and since
          // the old code stopped at the first resolution with any data, it locked onto hourly and
          // never tried a finer one - this is why the evCharger chart stepped hourly even when the
          // price source (e.g. dap15) is 15-minute resolution. 'last24Hours' gives ~5-minute
          // resolution for the most recent day; merge it over the coarse hourly data so the last
          // 24h is fine-grained and older-than-24h stays hourly (that's all Insights offers there).
          let coarse = null;
          for (const resStr of ['last7Days', 'last14Days', 'last31Days']) {
            const data = await api.insights.getLogEntries({
              id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: resStr,
            }).catch(() => null);
            coarse = convert(data, resStr);
            if (coarse) break;
          }

          const fineStart = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
          const fineData = await api.insights.getLogEntries({
            id: log.id, start: fineStart.toISOString(), end: endDate.toISOString(), resolution: 'last24Hours',
          }).catch(() => null);
          const fine = convert(fineData, 'last24Hours');

          if (!coarse && !fine) {
            const todayData = await api.insights.getLogEntries({
              id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: 'today',
            }).catch(() => null);
            const today = convert(todayData, 'today');
            if (today) return today;
            continue;
          }
          if (!fine) return coarse;
          if (!coarse) return fine;

          const fineMinTime = Math.min(...fine.map((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime())));
          const merged = coarse.filter((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime()) < fineMinTime).concat(fine);
          return merged;
        }
        return null;
      };

      // Fetch charger power entries for session boundary detection. Never search for a log
      // literally named 'measure_power' - Homey always logs that capability's own Insights
      // history under the internal log id 'energy_power' instead (see isCumulative comment
      // above, and homey-app-development skill Section 3). A literal 'measure_power' log CAN
      // exist in the log listing but with zero real samples (confirmed on grid's SmartMeter,
      // 2026-08-10), so it's not even tried here; fall back to cumulative meter_power only if
      // energy_power itself has no history.
      const powerEntries = await fetchLog(chargerId, ['energy_power', 'meter_power']);

      let socEntries = null;
      if (evId && evId !== 'none') {
        socEntries = await fetchLog(evId, ['measure_battery']);
      }

      if (!powerEntries || powerEntries.length < 2) {
        this.log('[EV Slot] No power history found in Insights for charger.');
        return;
      }

      if (powerEntries && powerEntries.length > 0) {
        const newHistoryMap = new Map();
        if (Array.isArray(this.powerHistory)) {
          this.powerHistory.forEach((e) => newHistoryMap.set(e.time, e.power));
        }
        powerEntries.forEach((e) => {
          const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
          newHistoryMap.set(t, Math.round(e.v || 0));
        });
        this.powerHistory = Array.from(newHistoryMap.entries())
          .map(([time, power]) => ({ time, power }))
          .sort((a, b) => a.time - b.time);
        if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.log(`[EV Slot] Populated ${this.powerHistory.length} spot power history entries from Insights.`);
      }

      if (socEntries && socEntries.length > 0) {
        const newSocHistoryMap = new Map();
        if (Array.isArray(this.socHistory)) {
          this.socHistory.forEach((e) => newSocHistoryMap.set(e.time, e.soc));
        }
        socEntries.forEach((e) => {
          const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
          if (typeof e.v === 'number') newSocHistoryMap.set(t, e.v);
        });
        this.socHistory = Array.from(newSocHistoryMap.entries())
          .map(([time, soc]) => ({ time, soc }))
          .sort((a, b) => a.time - b.time);
        if (this.socHistory.length > 2880) this.socHistory = this.socHistory.slice(-2880);
        await this.setStoreValue('socHistory', this.socHistory).catch(this.error);
        this.log(`[EV Slot] Populated ${this.socHistory.length} spot SoC history entries from Insights.`);
      }

      const chargingPowers = powerEntries
        .map((e) => e.v)
        .filter((p) => typeof p === 'number' && p > 500)
        .sort((a, b) => a - b);

      this.log(`[EV Power Auto-Detect] Found ${chargingPowers.length} active charging entries (>500W) in history.`);
      if (chargingPowers.length > 0) {
        const minP = Math.round(chargingPowers[0]);
        const p50P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.50)]);
        const p90P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.90)]);
        const p95P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.95)]);
        const p99P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.99)]);
        const maxP = Math.round(chargingPowers[chargingPowers.length - 1]);
        this.log(`[EV Power Auto-Detect] History Percentiles (Watts) -> min: ${minP}W, 50th: ${p50P}W, 90th: ${p90P}W, 95th: ${p95P}W, 99th: ${p99P}W, max: ${maxP}W`);

        const detectedMax = Math.round(p99P / 100) * 100;
        this.log(`[EV Power Auto-Detect] Selected peak power estimate (99th percentile): ${detectedMax} W`);
        if (detectedMax >= 1000) {
          await this.setStoreValue('detectedMaxPower', detectedMax);
          const currentSetting = this.getSettings().chargePower;
          if (!currentSetting || currentSetting === 11000) {
            await this.setSettings({ chargePower: detectedMax }).catch(this.error);
            this.log(`[EV Power Auto-Detect] Automatically updated chargePower setting from default to detected ${detectedMax} W`);
          }
        }
      }

      this.socForecastModel = EvDepartureStrategy.bootstrapFromHistory(
        powerEntries, socEntries, tz, batCap,
      );
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
      this.log('[EV Slot] Departure learning complete. Model updated from history.');
      await this.updateChargeChart().catch((err) => this.error(err));
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

Object.assign(CarChargeDevice.prototype, ChargeDeviceHelpers);

module.exports = CarChargeDevice;
