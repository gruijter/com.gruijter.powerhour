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

// The grid day log for widgets/grid (DayLog): kWh imported and exported and money per day. Estimates
// from the source's import (p1 + p2) and export (n1 + n2) registers.
const DayLog = require('./DayLog');
const SolarHistory = require('./SolarHistory');

module.exports = DayLog.create({
  key: 'gridDayLog',
  historyKey: 'gridDayLogFilled',
  fields: ['imported', 'exported'],
  lastDay: { imported: 'meter_kwh_last_day.imported', exported: 'meter_kwh_last_day.exported' },
  thisDay: { imported: 'meter_kwh_this_day.imported', exported: 'meter_kwh_this_day.exported' },
  meters: async (api, dev, field, points) => {
    const group = dev.sourceCapGroup || {};
    const sourceId = dev.getSettings().homey_device_id;
    const caps = (field === 'imported' ? ['p1', 'p2'] : ['n1', 'n2']).map((role) => group[role]).filter(Boolean);
    if (!sourceId || !caps.length || typeof dev.directionalLastWatt === 'number') return [];
    const parts = [];
    for (const cap of caps) parts.push({ sign: 1, values: await SolarHistory.meterValues(api, sourceId, [cap], points) });
    return [SolarHistory.combine(parts)];
  },
});
