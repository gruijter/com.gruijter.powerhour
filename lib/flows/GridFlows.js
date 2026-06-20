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

class GridFlows extends SumFlows {
  async retrain_load_model() {
    return this.device.retrainLoadModel(true); // Flow trigger: Retrain from scratch
  }

  async load_json(args) {
    const { period } = args;
    this.device.log('Creating load JSON via flow', this.device.getName(), period);

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
    const profile = this.device.weeklyProfile || LoadForecastStrategy.initializeProfile();

    for (let t = start; t < end; t += 15 * 60 * 1000) {
      const details = LoadForecastStrategy.getLocalTimeDetails(t, timezone);
      const power = profile[details.dayOfWeek][details.slotIndex] || 0;
      values.push(power);
    }

    return { load: JSON.stringify(values) };
  }

  async triggerForecastUpdated() {
    if (!this.device.homey.app.trigger_load_forecast_updated) return;

    for (const period of ['this_day', 'tomorrow', 'next_hours']) {
      try {
        const tokens = await this.load_json({ period });
        const state = { period };
        await this.device.homey.app.trigger_load_forecast_updated(this.device, tokens, state);
      } catch (err) {
        this.device.error(`Error triggering load_forecast_updated for ${period}`, err);
      }
    }
  }
}

module.exports = GridFlows;
