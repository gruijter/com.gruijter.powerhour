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
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const { imageUrlToStream } = require('../../lib/charts/ImageHelpers');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');

class BatDevice extends GenericDevice {

  async onInit() {
    await super.onInit().catch(this.error);
    this.powerHistory = (await this.getStoreValue('powerHistory')) || [];
    this.socHistory = (await this.getStoreValue('socHistory')) || [];

    const currentSessionId = this.sessionId;
    this.populateHistoryFromInsights().catch((err) => this.error('Error populating battery insights:', err));

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
    // 1. Prefer the official Homey battery-energy-class standard: class 'battery' with
    // 'measure_battery' + 'measure_power', where measure_power already follows the Homey
    // convention (positive = charging, negative = discharging) - no sign correction needed.
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
        this.sourcePowerInvert = false;
        return;
      }
    }

    // 2. Fall back to the documented vendor exceptions list (see driver.js sourceCapGroups) for
    // source devices that don't (yet) comply with the official Homey battery energy standard.
    // 'invertPower' is metadata, not a capability name, so it must not be used as a required
    // capability nor registered as a listener target below.
    const matchedGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.keys(capGroup)
        .filter((k) => k !== 'invertPower')
        .map((k) => capGroup[k])
        .filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!matchedGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
    this.sourcePowerInvert = !!matchedGroup.invertPower;
    this.sourceCapGroup = { ...matchedGroup };
    delete this.sourceCapGroup.invertPower;
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

  getActualSocForTime(timeMs) {
    if (!Array.isArray(this.socHistory) || this.socHistory.length === 0) {
      return null;
    }
    const candidates = this.socHistory.filter((d) => Math.abs(d.time - timeMs) < 60 * 60 * 1000);
    if (candidates.length === 0) return null;
    const closest = candidates.sort((a, b) => Math.abs(a.time - timeMs) - Math.abs(b.time - timeMs))[0];
    return typeof closest.soc === 'number' ? closest.soc : null;
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
      const rawLogs = await api.insights.getLogs().catch((err) => this.error('getLogs error:', err));
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
        // Homey stores the Insights log for the 'measure_power' capability itself (on devices with
        // energy-class registration, e.g. batteries) under the internal log id 'energy_power' - it
        // is the SAME signal as measure_power, just under a different Insights log name/id, not a
        // separate derived value. It is INSTANTANEOUS power (Watts), NOT cumulative, despite the
        // name. This log commonly exists (with full history) even when 'measure_power' itself has
        // no log of its own yet (confirmed empirically: energy_power values matched live
        // measure_power values almost exactly - same scale, same sign, 5-minute resolution).
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
          // 'energy_power' AND 'measure_battery' hourly entries are already stamped at the START
          // of the hour they represent (confirmed empirically against a real device: both logs'
          // raw 09:00 UTC entry lined up exactly with the real 11:00 local transition seen in
          // Homey's own Insights graph - the SoC entry started rising at the same raw timestamp
          // the power entry jumped to charging). Applying the -1h correction below to either one
          // produces a real, visible 1-hour-too-early shift (SoC/power changing "before" they
          // should relative to each other). Unlike these two, other hourly logs ARE
          // END-of-interval stamped and DO need the -1h correction.
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

        // Two-stage fetch, mirroring solar's approach (drivers/solar/device.js): a single
        // 'last7Days'/'last14Days' fetch only ever returns HOURLY points, and since the old code
        // stopped at the first resolution with any data, it locked onto hourly and never tried a
        // finer one - this is why battery/SoC charts stepped hourly even when the price source
        // (e.g. dap15) is 15-minute resolution. 'last24Hours' gives ~5-minute resolution for the
        // most recent day (confirmed working in solar's fine-tuning fetch); merge it over the
        // coarse hourly data so the last 24h is fine-grained and 24-48h ago stays hourly (that's
        // all Insights offers that far back).
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

      // 1. Power history. Prefer the exact capability already resolved by addSourceCapGroup()
      // (matches what the live capability listener reads), including its sign correction - this
      // avoids independently re-guessing and silently falling back to a legacy/inverted capability
      // (e.g. Sessy's 'measure_power.battery') purely because Homey Insights hasn't logged the
      // correct one yet.
      //
      // IMPORTANT (confirmed empirically, don't re-break this): on devices with energy-class
      // registration, Homey stores the Insights log for 'measure_power' itself under the internal
      // log id 'energy_power' - same signal, different log name, NOT a separate derived value and
      // NOT cumulative despite the name. It commonly has full history even when 'measure_power' has
      // no Insights log of its own yet - always try it as a fallback, and never invert it (it's
      // measure_power's own history, already Homey-standard-signed by construction).
      const resolvedPowerCap = (this.sourceCapGroup && (this.sourceCapGroup.newMeasurePower || this.sourceCapGroup.power)) || null;
      const resolvedPowerInvert = !!this.sourcePowerInvert;

      const powerCandidates = [];
      if (resolvedPowerCap) powerCandidates.push({ cap: resolvedPowerCap, invert: resolvedPowerInvert });
      powerCandidates.push({ cap: 'energy_power', invert: false });
      if (!resolvedPowerCap) {
        // No single signed power capability resolved (e.g. a chargePower/dischargePower magnitude
        // pair vendor) - fall back to the broad priority guess as a last resort.
        ['measure_power', 'measure_power.battery', 'measure_power.sessy', 'meter_power'].forEach((cap) => powerCandidates.push({ cap, invert: false }));
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

  async handleUpdateMeter(reading) {
    // This override previously shadowed GenericDevice#handleUpdateMeter entirely (same method
    // name), silently skipping the base class's meter-period bookkeeping (meter_power_hidden,
    // lastReadingHour/Day/Month/Year) and money calculation (meter_money_*) since the "graphs
    // upgrade" commit that introduced this override. Restore the base behaviour.
    await super.handleUpdateMeter(reading);

    // Neither this device nor the HomeyAPI sourceDevice wrapper expose a 'measure_power'
    // capability/method, so that lookup always failed. The device's own live signed
    // charge(+)/discharge(-) power is published on 'measure_watt_avg'.
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
    }
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    await this.refreshDapPrices().catch(() => {});
    this.log('updating charge chart', this.getName());
    const minPriceDelta = this.getSettings().roiMinProfit;
    const strategy = await this.flows.find_roi_strategy({ minPriceDelta }).catch((err) => this.error(err));
    if (!strategy) return;

    await this.setCapability('roi_duration', strategy.duration).catch((err) => this.error(err));
    if (this.pricesNextHoursIsForecast) {
      const scheme = JSON.parse(strategy.scheme);
      Object.keys(scheme).forEach((k) => {
        if (this.pricesNextHoursIsForecast[k]) scheme[k].isForecast = true;
      });
      strategy.scheme = JSON.stringify(scheme);
    }

    const stratScheme = JSON.parse(strategy.scheme);

    const now = new Date();
    now.setMilliseconds(0);
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const H0 = nowLocal.getHours();
    const M0 = Math.floor(nowLocal.getMinutes() / this.priceInterval) * this.priceInterval;
    const startHour = H0 + (M0 / 60);

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

    const chargePower = this.getSettings().chargePower || 2200;
    const dischargePower = this.getSettings().dischargePower || 1700;
    const currency = (this.getSettings() && this.getSettings().currency) || this.currency || (this.settings && this.settings.currency) || '€';
    const translations = {
      price: this.homey.__('price') || 'Prijs',
      power: this.homey.__('power') || 'Vermogen',
      soc: this.homey.__('soc') || 'SoC',
    };
    const showPower = !!this.getSettings().chartShowPower;
    const showSoc = this.getSettings().chartShowSoc !== false;

    // 1. Image 1: Yesterday (00:00 to 23:59 Yesterday)
    const yesterdayStartMs = todayStartMs - (24 * 60 * 60 * 1000);
    const yesterdayStrategy = {};

    for (let i = 0; i < totalDaySlots; i += 1) {
      const slotStartMs = yesterdayStartMs + (i * intervalMs);
      let actualP = this.getActualPowerForTime(slotStartMs);
      if (actualP === null) actualP = 0;
      const actualSoc = this.getActualSocForTime(slotStartMs);
      const slotPrice = this.getPriceForTimestamp(slotStartMs);
      const planned = this.getPlannedScheduleForSlot(i, true);

      yesterdayStrategy[i] = {
        power: planned.power,
        actualPower: actualP,
        duration: planned.duration,
        soc: actualSoc,
        price: slotPrice,
        isForecast: false,
      };
    }

    const chartYesterday = await getChargeChart(
      { scheme: JSON.stringify(yesterdayStrategy) },
      0,
      totalDaySlots,
      chargePower,
      dischargePower,
      this.priceInterval,
      null,
      currency,
      translations,
      false,
      this.timeZone,
      showPower,
      showSoc,
    );

    this.chartYesterdayCharge = chartYesterday;
    if (!this.yesterdayChargeImage) {
      this.yesterdayChargeImage = await this.homey.images.createImage();
      this.yesterdayChargeImage.setStream(async (stream) => imageUrlToStream(this.chartYesterdayCharge, stream, this));
      await this.setCameraImage('yesterdayChargeChart', ` ${this.homey.__('yesterday')}`, this.yesterdayChargeImage);
    }
    await this.yesterdayChargeImage.update().catch((err) => this.error(err));

    // 2. Image 2: Today (00:00 to 23:59 Today)
    const todayStrategy = {};
    const todayDateStr = nowLocal.toDateString();
    await this.recordPlannedSchedule(stratScheme, currentSlotInDay, totalDaySlots, todayDateStr);

    for (let i = 0; i < totalDaySlots; i += 1) {
      const slotStartMs = todayStartMs + (i * intervalMs);
      const isPastOrPresent = slotStartMs <= now.getTime();
      let actualP = this.getActualPowerForTime(slotStartMs);
      if (isPastOrPresent && actualP === null) actualP = 0;
      let actualSoc = this.getActualSocForTime(slotStartMs);
      if (isPastOrPresent && actualSoc === null && i <= currentSlotInDay) {
        actualSoc = typeof this.soc === 'number' ? this.soc : null;
      }
      const slotPrice = this.getPriceForTimestamp(slotStartMs);

      if (i < currentSlotInDay) {
        const planned = this.getPlannedScheduleForSlot(i);
        todayStrategy[i] = {
          power: planned.power,
          actualPower: actualP,
          duration: planned.duration,
          soc: actualSoc,
          price: slotPrice,
          isForecast: false,
        };
      } else {
        const stratIdx = i - currentSlotInDay;
        if (stratScheme && stratScheme[stratIdx]) {
          todayStrategy[i] = {
            ...stratScheme[stratIdx],
            actualPower: isPastOrPresent ? actualP : (stratScheme[stratIdx].actualPower || null),
            soc: isPastOrPresent && actualSoc !== null ? actualSoc : (stratScheme[stratIdx].soc || null),
            // stratScheme's own isForecast flag reflects whether the *price* for that slot is
            // forecasted, not whether the slot itself has actually happened yet. A slot that
            // hasn't occurred must always render as planned/forecast, regardless of price origin.
            isForecast: isPastOrPresent ? !!stratScheme[stratIdx].isForecast : true,
          };
        } else {
          todayStrategy[i] = {
            power: 0,
            actualPower: isPastOrPresent ? actualP : null,
            duration: 0,
            soc: isPastOrPresent ? actualSoc : null,
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
      dischargePower,
      this.priceInterval,
      null,
      currency,
      translations,
      true,
      this.timeZone,
      showPower,
      showSoc,
    );

    this.chartTodayCharge = chartToday;
    if (!this.todayChargeImage) {
      this.todayChargeImage = await this.homey.images.createImage();
      this.todayChargeImage.setStream(async (stream) => imageUrlToStream(this.chartTodayCharge, stream, this));
      await this.setCameraImage('todayChargeChart', ` ${this.homey.__('today')}`, this.todayChargeImage);
    }
    await this.todayChargeImage.update().catch((err) => this.error(err));

    // 3. Image 3: Tomorrow (00:00 to 23:59 Tomorrow)
    const tomorrowStrategy = {};
    const remainingTodaySlots = totalDaySlots - currentSlotInDay;

    for (let i = 0; i < totalDaySlots; i += 1) {
      const stratIdx = remainingTodaySlots + i;
      if (stratScheme && stratScheme[stratIdx]) {
        tomorrowStrategy[i] = stratScheme[stratIdx];
      } else {
        tomorrowStrategy[i] = {
          power: 0,
          duration: 0,
          soc: null,
          price: null,
          isForecast: true,
        };
      }
    }

    const chartTomorrow = await getChargeChart(
      { scheme: JSON.stringify(tomorrowStrategy) },
      0,
      totalDaySlots,
      chargePower,
      dischargePower,
      this.priceInterval,
      null,
      currency,
      translations,
      false,
      this.timeZone,
      showPower,
      showSoc,
    );

    this.chartTomorrowCharge = chartTomorrow;
    if (!this.tomorrowChargeImage) {
      this.tomorrowChargeImage = await this.homey.images.createImage();
      this.tomorrowChargeImage.setStream(async (stream) => imageUrlToStream(this.chartTomorrowCharge, stream, this));
      await this.setCameraImage('tomorrowChargeChart', ` ${this.homey.__('tomorrow')}`, this.tomorrowChargeImage);
    }
    await this.tomorrowChargeImage.update().catch((err) => this.error(err));

    // 4. Image 4: Next Hours (Rolling Window starting from current hour H0)
    const chartNextHours = await getChargeChart(
      strategy,
      startHour,
      this.pricesNextHoursMarketLength,
      chargePower,
      dischargePower,
      this.priceInterval,
      this.exportPricesNextHours,
      currency,
      translations,
      false,
      this.timeZone,
      showPower,
      showSoc,
    );
    this.chartNextHoursCharge = chartNextHours;
    if (!this.nextHoursChargeImage) {
      this.nextHoursChargeImage = await this.homey.images.createImage();
      this.nextHoursChargeImage.setStream(async (stream) => imageUrlToStream(this.chartNextHoursCharge, stream, this));
      await this.setCameraImage('nextHoursChargeChart', ` ${this.homey.__('nextHours')}`, this.nextHoursChargeImage);
    }
    await this.nextHoursChargeImage.update().catch((err) => this.error(err));
  }

  triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower) {
    if (!this.flows) return Promise.resolve(false);
    return this.flows.triggerXomFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
  }
}

Object.assign(BatDevice.prototype, ChargeDeviceHelpers);

module.exports = BatDevice;
