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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const ChartImages = require('../../lib/helpers/ChartImages');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const { setTimeoutPromise } = require('../../lib/helpers/Util');

class BatDevice extends GenericDevice {

  async onInit() {
    // A (re)init can follow a settings change: never let the chart reuse a plan from before it.
    this.lastStratTm = null;
    // Before super.onInit(): it sets initReady partway, and onPricesUpdated() then renders charts.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    // Before super.onInit(): its first samples would otherwise overwrite the stored history.
    this.powerHistory = await this.loadStoredHistory('powerHistory');
    this.socHistory = await this.loadStoredHistory('socHistory');
    await super.onInit().catch(this.error);

    const currentSessionId = this.sessionId;
    this.populateHistoryFromInsights().catch((err) => this.error('Error populating battery insights:', err));

    if (this.getSettings().roiEnable) {
      const initStrategy = async () => {
        await setTimeoutPromise(10000 + (Math.random() * 60000), this);
        if (this.sessionId !== currentSessionId) return;
        if (this.pricesNextHours) {
          await this.flows.triggerNewRoiStrategyFlow().catch((err) => this.error(err));
          await this.updateChargeChart().catch((err) => this.error(err));
        }
      };
      initStrategy().catch((err) => this.error(err));
    }
  }

  async onPricesUpdated() {
    this.pricesUpdatedTm = Date.now(); // see updateChargeChart(): only reuse plans made after this
    if (!this.getSettings().roiEnable && this.latestPlan) { // no plan is followed: count as idle
      this.latestPlan = null;
      this.notifyChargePlanUpdated();
    }
    if (this.getSettings().roiEnable) {
      this.pricesUpdated = true;
      await this.flows.triggerNewRoiStrategyFlow();
      await this.updateChargeChart();
    }
  }

  // Detected by the driver, with the choice from the setup view (store 'sourceCaps').
  async addSourceCapGroup() {
    const resolved = this.driver.sourceCapGroupFor(this.sourceDevice, this.getStoreValue('sourceCaps'));
    if (!resolved) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
    this.sourceCapGroup = resolved.group;
    this.sourcePowerInvert = resolved.invert;
    this.log(`${this.sourceDevice.name} source capability group:`, JSON.stringify(resolved));
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

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
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;
    await this.getSourceDevice();

    if (!this.sourceCapGroup) await this.addSourceCapGroup();
    const promises = Object.keys(this.sourceCapGroup).map(async (key) => {
      if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]]) {
        const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]].value;
        await this.updateValue(val, key).catch(this.error);
      }
    });
    await Promise.all(promises);
  }

  async populateHistoryFromInsights() {
    try {
      if (!this.sourceDevice) {
        await this.getSourceDevice().catch(() => null);
      }
      if (!this.sourceDevice || !this.homey || !this.homey.app || !this.homey.app.api) {
        this.log('[Insights] Cannot populate history: sourceDevice or API not ready');
        return;
      }
      const sourceId = this.sourceDevice.id;
      const { api } = this.homey.app;
      const rawLogs = await this.homey.app.getInsightsLogs().catch((err) => this.error('getLogs error:', err));
      if (!rawLogs) return;

      const logs = Array.isArray(rawLogs) ? rawLogs : Object.values(rawLogs);
      const devLogs = logs.filter((l) => {
        const id = l.id || l.uri || l.ownerUri || '';
        return id.includes(sourceId);
      });
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 48 * 60 * 60 * 1000);

      const fetchEntries = async (log) => {
        if (!log) return null;
        const id = log.id || log.uri || '';
        const cap = id.split(':').pop() || '';
        // Homey logs measure_power under 'energy_power': instantaneous W, not cumulative (confirmed).
        const isCumulative = cap.includes('meter') || (cap.includes('energy') && cap !== 'energy_power');

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
              const prevT = typeof prev.t === 'number' ? prev.t : new Date(prev.t).getTime();
              const currT = typeof curr.t === 'number' ? curr.t : new Date(curr.t).getTime();
              const dtHours = (currT - prevT) / 3600000;
              const dKwh = currV - prevV;
              if (dtHours > 0 && Math.abs(dKwh) < 500) {
                const watts = (dKwh / dtHours) * 1000;
                powerWatts.push({ time: prevT, power: Math.round(watts) });
              }
            }
            return { entries: powerWatts, isWatts: true };
          }
          // These hourly logs are stamped at the START of the hour (confirmed on a device); others at the
          // end and get the -1h correction.
          const startStampedCaps = ['energy_power', 'measure_battery'];
          const isHourly = (resStr === 'last7Days' || resStr === 'last14Days') && !startStampedCaps.includes(cap);
          const entries = data.values.map((e) => {
            const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
            const t = isHourly ? rawT - 3600000 : rawT;
            let v = 0;
            if (typeof e.v === 'number') v = e.v;
            else if (typeof e.y === 'number') v = e.y;
            return { time: t, value: Math.round(v) };
          });
          return { entries, isWatts: false };
        };

        // Hourly (last7Days/last14Days) plus 'last24Hours' (~5-minute) merged over it.
        let coarse = null;
        for (const resStr of ['last7Days', 'last14Days']) {
          const data = await api.insights.getLogEntries({
            id: log.id || log.uri,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: resStr,
          }).catch(() => null);
          coarse = convert(data, resStr);
          if (coarse) break;
        }

        const fineStart = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        const fineData = await api.insights.getLogEntries({
          id: log.id || log.uri,
          start: fineStart.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last24Hours',
        }).catch(() => null);
        const fine = convert(fineData, 'last24Hours');

        if (!coarse && !fine) {
          const todayData = await api.insights.getLogEntries({
            id: log.id || log.uri,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: 'today',
          }).catch(() => null);
          return convert(todayData, 'today');
        }
        if (!fine) return coarse;
        if (!coarse) return fine;

        const fineMinTime = Math.min(...fine.entries.map((e) => e.time));
        const merged = coarse.entries.filter((e) => e.time < fineMinTime).concat(fine.entries);
        return { entries: merged, isWatts: fine.isWatts };
      };

      // 1. Power history: the capability addSourceCapGroup() resolved, with its sign. A bare
      // 'measure_power' is read from 'energy_power' (a 'measure_power' log can exist but is empty,
      // skill section 3); suffixed variants under their own name.
      const resolvedPowerCap = (this.sourceCapGroup && (this.sourceCapGroup.newMeasurePower || this.sourceCapGroup.power)) || null;
      const resolvedPowerInvert = !!this.sourcePowerInvert;

      const powerCandidates = [];
      if (resolvedPowerCap && resolvedPowerCap !== 'measure_power') {
        powerCandidates.push({ cap: resolvedPowerCap, invert: resolvedPowerInvert });
      }
      powerCandidates.push({ cap: 'energy_power', invert: false });
      if (!resolvedPowerCap) {
        // No signed power capability resolved: broad guess as a last resort.
        ['measure_power.battery', 'measure_power.sessy', 'meter_power'].forEach((cap) => powerCandidates.push({ cap, invert: false }));
      }

      let powerLog = null;
      let powerLogInvert = false;
      for (const candidate of powerCandidates) {
        const found = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap === candidate.cap || l.name === candidate.cap;
        });
        if (found) {
          powerLog = found;
          powerLogInvert = candidate.invert;
          break;
        }
      }
      if (!powerLog && !resolvedPowerCap) {
        powerLog = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap.startsWith('measure_power.');
        });
      }
      if (!powerLog) this.log(`[Insights] No power log found for source device ${sourceId} (tried: ${powerCandidates.map((c) => c.cap).join(', ')})`);

      if (powerLog) {
        const result = await fetchEntries(powerLog);
        if (result && result.entries.length > 0) {
          const powerMap = new Map();
          if (Array.isArray(this.powerHistory)) {
            this.powerHistory.forEach((e) => powerMap.set(e.time, e.power));
          }
          result.entries.forEach((e) => {
            let val = result.isWatts ? e.power : e.value;
            if (powerLogInvert) val = -val;
            powerMap.set(e.time, val);
          });
          this.powerHistory = Array.from(powerMap.entries())
            .map(([time, power]) => ({ time, power }))
            .sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
          await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        }
      }

      // 2. SoC history: measure_battery (or soc)
      const socLog = devLogs.find((l) => {
        const id = l.id || l.uri || l.ownerUri || '';
        const cap = id.split(':').pop() || '';
        return cap === 'measure_battery' || cap === 'soc' || ['measure_battery', 'soc'].includes(l.name);
      });

      if (socLog) {
        const result = await fetchEntries(socLog);
        if (result && result.entries.length > 0) {
          const socMap = new Map();
          if (Array.isArray(this.socHistory)) {
            this.socHistory.forEach((e) => socMap.set(e.time, e.soc));
          }
          result.entries.forEach((e) => socMap.set(e.time, e.value));
          this.socHistory = Array.from(socMap.entries())
            .map(([time, soc]) => ({ time, soc }))
            .sort((a, b) => a.time - b.time);
          if (this.socHistory.length > 2880) this.socHistory = this.socHistory.slice(-2880);
          await this.setStoreValue('socHistory', this.socHistory).catch(this.error);
          this.log(`[Insights] Stored ${this.socHistory.length} SoC entries (source: ${socLog.id || socLog.name})`);
        }
      } else {
        this.log(`[Insights] No SoC log found for source device ${sourceId}`);
      }
    } catch (err) {
      this.error('Error populating battery insights:', err);
    }
  }

  async updateValue(val, cap) {
    await super.updateValue(val, cap);
    if (cap !== 'soc' || !this.recordSocSample(val)) return;
    await this.saveSocHistory();
  }

  async handleUpdateMeter(reading) {
    // Must call the base, or meter periods and money are skipped.
    await super.handleUpdateMeter(reading);

    // The live signed power is on 'measure_watt_avg'.
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
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    await this.refreshDapPrices().catch(() => {});
    const minPriceDelta = this.getSettings().roiMinProfit;
    // Reuse a plan from the same price slot and minPriceDelta (a flow trigger usually computed it
    // seconds ago), if made after the latest price update and the last (re)init.
    const slotMs = (this.priceInterval || 60) * 60 * 1000;
    // Price slots follow local time: bucket on local (offset-shifted) timestamps, not UTC epoch.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const localSlot = (ms) => Math.floor(TimeHelpers.toLocalDate(new Date(ms), tz).getTime() / slotMs);
    const sameSlot = this.lastStratTm && localSlot(this.lastStratTm) === localSlot(Date.now());
    const afterPrices = this.lastStratTm && this.lastStratTm >= (this.pricesUpdatedTm || 0);
    const strategy = (sameSlot && afterPrices && this.lastStratMinPriceDelta === minPriceDelta && this.lastStratTokens)
      ? { ...this.lastStratTokens }
      : await this.flows.find_roi_strategy({ minPriceDelta }).catch((err) => this.error(err));
    if (!strategy) return;

    await this.setCapability('roi_duration', strategy.duration).catch((err) => this.error(err));

    const scheme = JSON.parse(strategy.scheme);
    const { isForecast } = this.pricesFromNow();
    Object.keys(scheme).forEach((k) => {
      if (isForecast && isForecast[k]) scheme[k].isForecast = true;
    });

    await this.renderChargeCharts({
      scheme,
      chargePower: this.getSettings().chargePower || 2200,
      dischargePower: this.getSettings().dischargePower || 1700,
      socFallback: typeof this.soc === 'number' ? this.soc : null,
      planTm: this.lastStratTm || Date.now(),
      showPower: !!this.getSettings().chartShowPower,
      showSoc: this.getSettings().chartShowSoc !== false,
      showExportPrice: this.getSettings().chartShowExportPrice !== false,
    });
  }

  triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower) {
    if (!this.flows) return Promise.resolve(false);
    return this.flows.triggerXomFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
  }
}

Object.assign(BatDevice.prototype, ChargeDeviceHelpers);

module.exports = BatDevice;
