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
    // 1. Check for new Homey energy standard (battery class)
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
        return;
      }
    }

    // setup if/how a HOMEY-API source device fits to a defined capability group
    this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
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
        const isCumulative = cap.includes('meter') || cap.includes('energy');

        for (const resStr of ['last7Days', 'last14Days', 'today']) {
          const data = await api.insights.getLogEntries({
            id: log.id || log.uri,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: resStr,
          }).catch(() => null);
          if (data && data.values && data.values.length > 0) {
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
            const isHourly = resStr === 'last7Days' || resStr === 'last14Days';
            const entries = data.values.map((e) => {
              const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
              const t = isHourly ? rawT - 3600000 : rawT;
              let v = 0;
              if (typeof e.v === 'number') v = e.v;
              else if (typeof e.y === 'number') v = e.y;
              return { time: t, value: Math.round(v) };
            });
            return { entries, isWatts: false };
          }
        }
        return null;
      };

      // 1. Power history: Priority measure_power -> measure_power.* -> energy_power -> meter_power
      const powerCapPriority = ['measure_power', 'measure_power.battery', 'measure_power.sessy', 'energy_power', 'meter_power'];
      let powerLog = null;
      for (const capName of powerCapPriority) {
        powerLog = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap === capName || l.name === capName;
        });
        if (powerLog) break;
      }
      if (!powerLog) {
        powerLog = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap.startsWith('measure_power.');
        });
      }

      if (powerLog) {
        const result = await fetchEntries(powerLog);
        if (result && result.entries.length > 0) {
          const powerMap = new Map();
          if (Array.isArray(this.powerHistory)) {
            this.powerHistory.forEach((e) => powerMap.set(e.time, e.power));
          }
          result.entries.forEach((e) => {
            const val = result.isWatts ? e.power : e.value;
            powerMap.set(e.time, val);
          });
          this.powerHistory = Array.from(powerMap.entries())
            .map(([time, power]) => ({ time, power }))
            .sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
          await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        }
      } else {
        this.log(`[Insights] No power log found for source device ${sourceId}`);
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
