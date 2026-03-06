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
}

module.exports = SolarFlows;
