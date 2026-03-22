/* eslint-disable camelcase */
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

const SumFlows = require('./SumFlows');
const SolarLearningStrategy = require('../strategies/SolarLearningStrategy');

class SolarFlows extends SumFlows {
  async set_curtailment(args) {
    await this.device.setCapabilityValue('alarm_power', args.state).catch((err) => this.device.error(err));
    this.device.log(`Curtailment set to ${args.state}`);
    return true;
  }

  async retrain_solar_model() {
    return this.device.retrainSolarModel(true); // Flow trigger: Retrain from scratch
  }

  async solar_json(args) {
    const { period } = args;
    this.device.log('Creating solar JSON via flow', this.device.getName(), period);

    const now = new Date();
    const timezone = this.device.timeZone || 'UTC';

    // Helper to get UTC timestamp of Local Midnight
    const getLocalMidnightUTC = (d) => {
      const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
      const offset = local.getTime() - d.getTime();
      const midnightLocal = new Date(local);
      midnightLocal.setHours(0, 0, 0, 0);
      return midnightLocal.getTime() - offset;
    };

    const todayStart = getLocalMidnightUTC(now);
    const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
    const tomorrowEnd = tomorrowStart + 24 * 60 * 60 * 1000;

    let start;
    let end;

    if (period === 'this_day') {
      start = todayStart;
      end = tomorrowStart;
    } else if (period === 'tomorrow') {
      start = tomorrowStart;
      end = tomorrowEnd;
    } else if (period === 'next_hours') {
      // Start from current 15m slot until end of tomorrow
      start = now.getTime() - (now.getTime() % (15 * 60 * 1000));
      end = tomorrowEnd;
    } else {
      throw new Error('Unknown period');
    }

    const values = [];
    for (let t = start; t < end; t += 15 * 60 * 1000) {
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.device.forecastData);
      // Calculate slot index for yield factor (0-95 based on local time)
      const dateT = new Date(t);
      const localT = new Date(dateT.toLocaleString('en-US', { timeZone: timezone }));
      const slotIndex = (localT.getHours() * 4) + Math.floor(localT.getMinutes() / 15);
      const yf = this.device.yieldFactors[slotIndex] !== undefined ? this.device.yieldFactors[slotIndex] : 0;
      values.push(Math.round(rad * yf));
    }

    return { solar: JSON.stringify(values) };
  }

  async solar_yield_remaining(args) {
    const { time, value } = args;
    if (!time || value === undefined) return false;

    const now = new Date();
    const timezone = this.device.timeZone || 'UTC';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    // Parse time string HH:mm
    const [hours, minutes] = time.split(':').map(Number);
    const targetLocal = new Date(nowLocal);
    targetLocal.setHours(hours, minutes, 0, 0);

    // If target time is earlier than current time, remaining yield is 0
    if (targetLocal <= nowLocal) return (value > 0);

    // Get forecast from device
    // Note: getForecastRemaining is added to SolarDevice or we calculate here.
    // Accessing device forecast logic:
    if (!this.device.getForecastRemaining) return false;

    const remaining = this.device.getForecastRemaining(targetLocal); // Pass local Date object
    return remaining < value;
  }

  async solar_yield_between(args) {
    const { start_time, end_time, value } = args;
    if (!start_time || !end_time || value === undefined) return false;

    if (!this.device.getForecastBetween) return false;

    const now = new Date();
    const timezone = this.device.timeZone || 'UTC';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    const [startH, startM] = start_time.split(':').map(Number);
    const [endH, endM] = end_time.split(':').map(Number);

    const startLocal = new Date(nowLocal);
    startLocal.setHours(startH, startM, 0, 0);

    const endLocal = new Date(nowLocal);
    endLocal.setHours(endH, endM, 0, 0);

    const yieldValue = this.device.getForecastBetween(startLocal, endLocal);
    return yieldValue < value;
  }

  async solar_yield_period(args) {
    const { period, value } = args;
    if (value === undefined) return false;

    if (period === 'this_day') {
      return (this.device.getCapabilityValue('meter_kwh_forecast.this_day') || 0) > value;
    }
    if (period === 'tomorrow') {
      return (this.device.getCapabilityValue('meter_kwh_forecast.tomorrow') || 0) > value;
    }
    if (period === 'next_hours') {
      const now = new Date();
      const timezone = this.device.timeZone || 'UTC';
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
      const tomorrowLocal = new Date(nowLocal);
      tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
      tomorrowLocal.setHours(23, 59, 59, 999);
      return this.device.getForecastBetween(nowLocal, tomorrowLocal) > value;
    }
    return false;
  }

  async solar_yield_comparison(args) {
    const todayYield = this.device.getCapabilityValue('meter_kwh_forecast.this_day') || 0;
    const tomorrowYield = this.device.getCapabilityValue('meter_kwh_forecast.tomorrow') || 0;
    return tomorrowYield > todayYield;
  }

  async solar_curtailment_active(args) {
    return this.device.getCapabilityValue('alarm_power');
  }

  async solar_production_in_top(args) {
    return this.solar_production_enters_top(args);
  }

  async solar_production_enters_top(args) {
    const hours = Number(args.number) || 1;
    const topSlotsCount = hours * 4; // 15-minute intervals

    const now = new Date();
    const timezone = this.device.timeZone || 'UTC';
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    const todayStart = new Date(localNow);
    todayStart.setHours(0, 0, 0, 0);

    const currentSlotIndex = (localNow.getHours() * 4) + Math.floor(localNow.getMinutes() / 15);

    const offset = localNow.getTime() - now.getTime();
    const utcStart = todayStart.getTime() - offset;

    const todayYields = [];

    for (let i = 0; i < 96; i++) {
      const t = utcStart + i * 15 * 60 * 1000;
      const rad = SolarLearningStrategy.getInterpolatedRadiation(t, this.device.forecastData);
      const slotLocal = new Date(new Date(t).toLocaleString('en-US', { timeZone: timezone }));
      const sIdx = (slotLocal.getHours() * 4) + Math.floor(slotLocal.getMinutes() / 15);
      const yf = this.device.yieldFactors[sIdx] !== undefined ? this.device.yieldFactors[sIdx] : 0;
      const power = Math.round(rad * yf);
      todayYields.push({ slot: sIdx, power });
    }

    todayYields.sort((a, b) => b.power - a.power);

    if (topSlotsCount >= todayYields.length) return true;

    const thresholdPower = todayYields[Math.max(0, topSlotsCount - 1)].power;
    const currentSlotData = todayYields.find((y) => y.slot === currentSlotIndex);

    if (!currentSlotData) return false;
    return currentSlotData.power >= thresholdPower && currentSlotData.power > 0;
  }

  async triggerSolarYieldFlows() {
    if (this.device.homey.app.trigger_solar_yield_remaining) {
      await this.device.homey.app.trigger_solar_yield_remaining(this.device, {}, {}).catch((err) => {
        this.device.error('Error triggering solar_yield_remaining', err);
      });
    }
    if (this.device.homey.app.trigger_solar_yield_between) {
      await this.device.homey.app.trigger_solar_yield_between(this.device, {}, {}).catch((err) => {
        this.device.error('Error triggering solar_yield_between', err);
      });
    }
    if (this.device.homey.app.trigger_solar_production_enters_top) {
      await this.device.homey.app.trigger_solar_production_enters_top(this.device, {}, {}).catch((err) => {
        this.device.error('Error triggering solar_production_enters_top', err);
      });
    }
  }

  async triggerForecastUpdated() {
    if (!this.device.homey.app.trigger_solar_forecast_updated) return;

    for (const period of ['this_day', 'tomorrow', 'next_hours']) {
      try {
        const tokens = await this.solar_json({ period });
        const state = { period };
        await this.device.homey.app.trigger_solar_forecast_updated(this.device, tokens, state);
      } catch (err) {
        this.device.error(`Error triggering solar_forecast_updated for ${period}`, err);
      }
    }
  }
}

module.exports = SolarFlows;
