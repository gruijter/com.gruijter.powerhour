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

const DayLog = require('./DayLog');
const SolarHistory = require('./SolarHistory');

module.exports = DayLog.create({
  key: 'batteryDayLog',
  historyKey: 'batteryDayLogFilled',
  fillVersion: 2,
  fields: ['charged', 'discharged'],
  lastDay: { charged: 'meter_kwh_last_day.charged', discharged: 'meter_kwh_last_day.discharged' },
  thisDay: { charged: 'meter_kwh_this_day.charged', discharged: 'meter_kwh_this_day.discharged' },
  meters: async (api, dev, field, points) => {
    const own = await SolarHistory.meterValues(api, dev.getId(), [field === 'charged' ? 'meter_kwh_charging' : 'meter_kwh_discharging'], points);
    const cap = dev.sourceCapGroup && dev.sourceCapGroup[field === 'charged' ? 'meterCharging' : 'meterDischarging'];
    const sourceId = dev.getSettings().homey_device_id;
    const source = cap && sourceId ? await SolarHistory.meterValues(api, sourceId, [cap], points) : null;
    return [own, source];
  },
});
