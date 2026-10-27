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
const TimeHelpers = require('../helpers/TimeHelpers');

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

    // DST-safe local midnight boundaries (real UTC Dates via TimeHelpers)
    const todayStartUTC = TimeHelpers.getLocalMidnightUTC(now, timezone);
    const tomorrowStartUTC = TimeHelpers.getLocalMidnightUTC(new Date(todayStartUTC.getTime() + 26 * 60 * 60 * 1000), timezone);
    const tomorrowEndUTC = TimeHelpers.getLocalMidnightUTC(new Date(tomorrowStartUTC.getTime() + 26 * 60 * 60 * 1000), timezone);

    const todayStart = todayStartUTC.getTime();
    const tomorrowStart = tomorrowStartUTC.getTime();
    const tomorrowEnd = tomorrowEndUTC.getTime();

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
      throw new Error(this.device.homey.__('error_unknown_period', { period }));
    }

    const values = this.device.getForecastSeries(start, end);

    return { solar: JSON.stringify(values) };
  }

  // A flow time arg ('07:30', 7.5, or HH:MM from the old time picker) as a local Date today.
  localTimeToday(value, nowLocal) {
    const hours = TimeHelpers.parseClock(value);
    if (hours === null) throw Error(this.device.homey.__('error_invalid_time', { time: value }));
    const minutes = Math.round(hours * 60);
    const local = new Date(nowLocal);
    local.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return local;
  }

  async solar_yield_remaining(args) {
    const { time, value } = args;
    if (!time || value === undefined) return false;

    const nowLocal = TimeHelpers.toLocalDate(new Date(), this.device.timeZone || 'UTC');
    const targetLocal = this.localTimeToday(time, nowLocal);

    // If target time is earlier than current time, remaining yield is 0
    if (targetLocal <= nowLocal) return (value > 0);

    if (!this.device.getForecastRemaining) return false;

    const remaining = this.device.getForecastRemaining(targetLocal); // Pass local Date object
    return remaining < value;
  }

  async solar_yield_between(args) {
    const { start_time, end_time, value } = args;
    if (!start_time || !end_time || value === undefined) return false;

    if (!this.device.getForecastBetween) return false;

    const nowLocal = TimeHelpers.toLocalDate(new Date(), this.device.timeZone || 'UTC');
    const startLocal = this.localTimeToday(start_time, nowLocal);
    const endLocal = this.localTimeToday(end_time, nowLocal);

    // Handle overnight windows (e.g. 22:00 – 06:00): end is on the next local day
    if (endLocal <= startLocal) {
      endLocal.setDate(endLocal.getDate() + 1);
    }

    const yieldValue = this.device.getForecastBetween(startLocal, endLocal);
    return yieldValue < value;
  }

  // Text time args; the cards above (time picker) are deprecated.
  async solar_yield_until(args) {
    return this.solar_yield_remaining(args);
  }

  async solar_yield_window(args) {
    return this.solar_yield_between(args);
  }

  // Expected yield (kWh) for this_day, tomorrow or next_hours (now to the end of tomorrow).
  expectedYield(period) {
    if (period === 'this_day') return this.device.getCapabilityValue('meter_kwh_forecast.this_day') || 0;
    if (period === 'tomorrow') return this.device.getCapabilityValue('meter_kwh_forecast.tomorrow') || 0;
    if (period === 'next_hours') {
      const timezone = this.device.timeZone || 'UTC';
      const nowLocal = TimeHelpers.toLocalDate(new Date(), timezone);
      const tomorrowLocal = new Date(nowLocal);
      tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
      tomorrowLocal.setHours(23, 59, 59, 999);
      return this.device.getForecastBetween(nowLocal, tomorrowLocal);
    }
    return null;
  }

  // Deprecated: !{{more|less}}; solar_yield_expected is !{{less|more}}.
  async solar_yield_period(args) {
    const kwh = this.expectedYield(args.period);
    if (args.value === undefined || kwh === null) return false;
    return kwh > args.value;
  }

  async solar_yield_expected(args) {
    const kwh = this.expectedYield(args.period);
    if (args.value === undefined || kwh === null) return false;
    return kwh < args.value;
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

    // DST-safe local midnight for today (real UTC)
    const todayStartUTC = TimeHelpers.getLocalMidnightUTC(now, timezone);

    // yieldFactors[] is trained and indexed by genuine UTC hour (see solar/device.js
    // updateLearning()) — read it back directly from real UTC timestamps, no local conversion.
    const currentSlotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);

    const todayYields = [];

    for (let i = 0; i < 96; i++) {
      const tUTC = todayStartUTC.getTime() + i * 15 * 60 * 1000;
      const slotIndex = (new Date(tUTC).getUTCHours() * 4) + Math.floor(new Date(tUTC).getUTCMinutes() / 15);
      const power = Math.round(this.device.forecastPowerAt(tUTC));
      todayYields.push({ slot: slotIndex, power });
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
    if (this.device.homey.app.trigger_solar_yield_until) {
      await this.device.homey.app.trigger_solar_yield_until(this.device, {}, {}).catch((err) => {
        this.device.error('Error triggering solar_yield_until', err);
      });
    }
    if (this.device.homey.app.trigger_solar_yield_window) {
      await this.device.homey.app.trigger_solar_yield_window(this.device, {}, {}).catch((err) => {
        this.device.error('Error triggering solar_yield_window', err);
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

    const periods = await this.getUsedPeriods(this.device.homey.app.solar_forecast_updated);
    for (const period of periods) {
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
