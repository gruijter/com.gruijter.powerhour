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

// The EV charger day log for widgets/ev (DayLog): kWh charged (and discharged with V2X) and money per
// day. Estimates from the own meters, else the charger's meter (source p1).
const DayLog = require('./DayLog');
const SolarHistory = require('./SolarHistory');

module.exports = DayLog.create({
  key: 'evDayLog',
  historyKey: 'evDayLogFilled',
  fillVersion: 2, // 1 left an inactive field unknown
  fields: ['charged', 'discharged'],
  active: (dev, field) => field === 'charged' || !!dev.getSettings().v2x,
  // V2X: charged and discharged apart (generic_bat_device.updateCounterPeriods()); else the day total.
  lastDay: (dev) => (dev.getSettings().v2x
    ? { charged: 'meter_kwh_last_day.charged', discharged: 'meter_kwh_last_day.discharged' }
    : { charged: 'meter_kwh_last_day' }),
  thisDay: (dev) => (dev.getSettings().v2x
    ? { charged: 'meter_kwh_this_day.charged', discharged: 'meter_kwh_this_day.discharged' }
    : { charged: 'meter_kwh_this_day' }),
  meters: async (api, dev, field, points) => {
    const own = await SolarHistory.meterValues(api, dev.getId(), [field === 'charged' ? 'meter_kwh_charging' : 'meter_kwh_discharging'], points);
    const cap = field === 'charged' && dev.sourceCapGroup ? dev.sourceCapGroup.p1 : null;
    const sourceId = dev.getSettings().homey_device_id;
    const source = cap && sourceId ? await SolarHistory.meterValues(api, sourceId, [cap], points) : null;
    return [own, source];
  },
});
