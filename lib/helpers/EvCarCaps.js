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

const SourceCaps = require('./SourceCaps');
const EvPresence = require('../strategies/EvPresence');

const CAR_CAPS = {
  soc: { ids: ['measure_battery'] },
  plugState: {
    ids: ['evcharger_charging_state', 'ev_charging_state'],
    guessed: ['car_plugged', 'is_plug_connected', 'porsche_plug_connected', 'leapmotor_plugged'],
    kind: 'plug',
  },
  plugBool: { ids: ['evcharger_charging'] },
  latitude: {
    ids: ['latitude'],
    guessed: ['measure_latitude', 'location_latitude', 'measure_location_latitude', 'leapmotor_latitude'],
    kind: 'number',
  },
  longitude: {
    ids: ['longitude'],
    guessed: ['measure_longitude', 'location_longitude', 'measure_location_longitude', 'leapmotor_longitude'],
    kind: 'number',
  },
  odometer: { ids: ['measure_odo'], kind: 'number' },
  homeDistance: { ids: ['meter_distance'], guessed: ['measure_distance.home', 'measure_distance_home'], kind: 'number' },
  atHome: {
    guessed: ['car_at_home', 'measure_polestarAtHome', 'at_home', 'measure_isHome', 'is_home'],
    kind: 'bool',
  },
  chargeLimit: { ids: ['charge_target_slow'], kind: 'limit' },
  startCharge: { ids: ['charge'], kind: 'action', setable: 'strict' },
};

const CHOOSABLE = ['plugState', 'latitude', 'longitude', 'homeDistance', 'atHome', 'odometer', 'chargeLimit', 'startCharge'];

const resolveRoles = (device, table, selected = {}) => {
  const caps = (device && device.capabilities) || [];
  const capsObj = (device && device.capabilitiesObj) || {};
  const group = {};
  Object.entries(table).forEach(([key, role]) => {
    const choice = selected[key];
    if (choice === 'none') return;
    if (choice && choice !== 'auto' && caps.includes(choice)) {
      group[key] = choice;
      return;
    }
    const usable = (id) => caps.includes(id) && (!role.setable
      || (role.setable === 'strict' ? capsObj[id]?.setable === true : capsObj[id]?.setable !== false));
    const cap = (role.ids || []).find(usable)
      || (role.guessed || []).find((id) => usable(id) && SourceCaps.fits(id, capsObj[id], role.kind));
    if (cap) group[key] = cap;
  });
  return group;
};

const roleRows = (device, table, choosable, auto, chosen, prefix, label) => SourceCaps.roleItems(device,
  choosable.map((key) => ({ key, kind: table[key].kind, label: label(`${prefix}${key}`) })), auto, chosen)
  .map((item) => ({ ...item, key: `${prefix}${item.key}` }));

const resolveCarCaps = (car, selected = {}) => {
  const group = resolveRoles(car, CAR_CAPS, selected);
  const capsObj = (car && car.capabilitiesObj) || {};
  if (group.startCharge && capsObj[group.startCharge]?.setable !== true) delete group.startCharge;
  if (!group.latitude || !group.longitude) {
    delete group.latitude;
    delete group.longitude;
  }
  return group;
};

const carCapRows = (car, chosen, label) => roleRows(car, CAR_CAPS, CHOOSABLE, resolveCarCaps(car), chosen, 'car_', label);

const AWAY_FLAG_KM = 10;

const KM_PER_UNIT = { m: 0.001, mi: 1.609344, miles: 1.609344 };

const toKm = (value, units) => value * (KM_PER_UNIT[units] || 1);

const tmOf = (entry) => {
  const t = entry && entry.lastUpdated ? new Date(entry.lastUpdated).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

const carDistance = (capsObj, group, home = {}) => {
  const read = (cap) => (capsObj && cap && capsObj[cap] ? capsObj[cap] : null);
  const num = (entry) => (entry && entry.value !== null && entry.value !== '' ? Number(entry.value) : NaN);
  const lat = num(read(group.latitude));
  const lon = num(read(group.longitude));
  if (group.latitude && Number.isFinite(lat) && Number.isFinite(lon)
    && typeof home.lat === 'number' && typeof home.lon === 'number') {
    return {
      km: EvPresence.distanceKm(lat, lon, home.lat, home.lon),
      tm: Math.max(tmOf(read(group.latitude)) || 0, tmOf(read(group.longitude)) || 0) || null,
      source: 'location',
    };
  }
  const dist = read(group.homeDistance);
  const value = num(dist);
  if (Number.isFinite(value)) return { km: toKm(value, dist.units), tm: tmOf(dist), source: 'distance' };
  const atHome = read(group.atHome);
  if (atHome && typeof atHome.value === 'boolean') {
    return { km: atHome.value ? 0 : AWAY_FLAG_KM, tm: tmOf(atHome), source: 'home' };
  }
  return { km: null, tm: null, source: null };
};

module.exports = {
  CAR_CAPS,
  CHOOSABLE,
  AWAY_FLAG_KM,
  resolveRoles,
  roleRows,
  resolveCarCaps,
  carCapRows,
  carDistance,
  toKm,
};
