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

const {
  getFlows, deviceZones, homeyZoneTotals, ownDeviceIds, sourceDeviceIds, allZoneIds,
} = require('../../lib/helpers/WidgetData');

module.exports = {
  // period: now (W) or hour/day/month/year (kWh); ids: the chosen devices, comma separated; zones=1:
  // with the zone of each user; homey=1: with Homey Energy's usage per zone.
  async getFlows({ homey, query }) {
    const ids = query && query.ids ? String(query.ids).split(',').filter(Boolean) : [];
    const flows = getFlows(homey, query && query.period, ids);
    // With zones: per user the zone of its source device, else that of the Power Summarizer itself.
    // homey=1: also Homey Energy's devices as users (all, or the chosen ones) with Homey Energy's values,
    // and its usage per zone (zoneTotals by zone name). Not this app's devices nor their sources: those
    // are the PbtH users already (counted once).
    if (query && query.zones === '1') {
      const homeyOn = query.homey === '1';
      const zones = await deviceZones(homey, flows.users.flatMap((u) => [u.sourceId, u.id].filter(Boolean)));
      flows.users.forEach((u) => {
        const z = zones[u.sourceId] || zones[u.id] || null;
        u.zone = z ? z.name : null;
        u.zoneId = z ? z.id : null;
        u.zoneOrder = z ? z.order : null;
      });
      if (homeyOn) {
        const own = ownDeviceIds(homey);
        const sources = sourceDeviceIds(homey, new Set(flows.users.map((u) => u.id)));
        const isExt = (id) => !own.has(id) && !sources.has(id);
        // Zones to read: all (nothing chosen), else those of the users and of the chosen Homey devices.
        let zoneIds;
        if (ids.length) {
          const chosenExt = await deviceZones(homey, ids.filter(isExt));
          zoneIds = [...new Set(flows.users.map((u) => u.zoneId).concat(Object.values(chosenExt).map((z) => z && z.id)).filter(Boolean))];
        } else zoneIds = await allZoneIds(homey);
        const homeyData = await homeyZoneTotals(homey, query.period, zoneIds);
        if (homeyData) {
          const ext = Object.keys(homeyData.devices).filter((id) => isExt(id) && (!ids.length || ids.includes(id)));
          const extZones = await deviceZones(homey, ext);
          ext.forEach((id) => {
            const z = extZones[id];
            flows.users.push({
              id,
              name: homeyData.devices[id].name,
              value: homeyData.devices[id].value,
              zone: z ? z.name : null,
              zoneId: z ? z.id : null,
              zoneOrder: z ? z.order : null,
            });
          });
          // Live: a Power Summarizer with Homey's value of its source, as in the zone total (its own
          // average lags behind).
          if (query.period === 'now') {
            flows.users.forEach((u) => {
              if (u.sourceId && homeyData.devices[u.sourceId]) u.value = homeyData.devices[u.sourceId].value;
            });
          }
          flows.zoneTotals = {};
          flows.users.forEach((u) => {
            if (u.zoneId && typeof homeyData.totals[u.zoneId] === 'number') flows.zoneTotals[u.zone] = homeyData.totals[u.zoneId];
          });
        }
      }
    }
    return flows;
  },
};
