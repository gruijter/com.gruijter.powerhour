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

/* eslint-disable camelcase */

'use strict';

const SumFlows = require('./SumFlows');
const LoadForecastStrategy = require('../strategies/LoadForecastStrategy');
const TimeHelpers = require('../helpers/TimeHelpers');
const EvPlanner = require('../strategies/EvPlanner');

class GridFlows extends SumFlows {
  async retrain_load_model() {
    return this.device.retrainLoadModel(true);
  }

  async add_planned_load(args) {
    const time = EvPlanner.parseTime(args.time);
    if (!time) throw Error(this.device.homey.__('error_invalid_time', { time: args.time }));
    const duration = Number(args.duration);
    const power = Number(args.power);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(power) || power < 0) {
      throw Error(this.device.homey.__('error_value_not_number'));
    }
    await this.device.addPlannedLoad(args.day, time, duration, power);
    return true;
  }

  // `shared` lets triggerForecastUpdated() compute the period-independent tokens once for all
  // three periods instead of three times.
  async load_json(args, shared = null) {
    const { period } = args;
    this.device.log('Creating load JSON via flow', this.device.getName(), period);

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

    const net = this.device.getNetForecast ? this.device.getNetForecast(start, end) : null;
    const values = net ? net.load : LoadForecastStrategy.getLoadSeries(this.device.weeklyProfile, start, end, timezone, this.device.plannedLoads);

    const { accuracy, peak } = shared || this.getSharedLoadTokens();
    return {
      load: JSON.stringify(values),
      accuracy,
      net: JSON.stringify(net ? net.netNoBattery : []),
      net_planned: JSON.stringify(net ? net.netPlanned : []),
      peak,
    };
  }

  getSharedLoadTokens() {
    return {
      accuracy: JSON.stringify(this.device.getForecastAccuracy ? this.device.getForecastAccuracy() : {}),
      peak: JSON.stringify(this.device.getPeakForecast ? this.device.getPeakForecast() : {}),
    };
  }

  async peak_headroom_below(args) {
    const p = this.device.peakProjection;
    if (!p || typeof p.headroomW !== 'number') return false;
    return p.headroomW < Number(args.power);
  }

  async triggerPeakProjectedExceeded(projectedW, monthPeakW) {
    if (!this.device.homey.app.trigger_peak_projected_exceeded) return;
    await this.device.homey.app.trigger_peak_projected_exceeded(this.device, { projected: projectedW, month_peak: monthPeakW }, {});
  }

  async triggerForecastUpdated() {
    if (!this.device.homey.app.trigger_load_forecast_updated) return;

    const periods = await this.getUsedPeriods(this.device.homey.app.load_forecast_updated);
    if (periods.length === 0) return;
    const shared = this.getSharedLoadTokens();
    for (const period of periods) {
      try {
        const tokens = await this.load_json({ period }, shared);
        const state = { period };
        await this.device.homey.app.trigger_load_forecast_updated(this.device, tokens, state);
      } catch (err) {
        this.device.error(`Error triggering load_forecast_updated for ${period}`, err);
      }
    }
  }
}

module.exports = GridFlows;
