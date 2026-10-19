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

// Capabilities read from (or set on) the linked car device. 'Automatic' takes the first id of a
// role the car has. ids: Homey standard ids plus ids confirmed in specific car apps
// (com.kia_hyundai: latitude/longitude, measure_odo, charge_target_slow, charge, meter_distance).
// guessed: ids of other car apps in the Homey app store, by their manifest only: used when their
// type fits the kind. For other car apps the user picks a capability per role at repair; the
// choice is kept in the device store.
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
  // Distance to home; com.kia_hyundai logs it in Insights (not its location).
  homeDistance: { ids: ['meter_distance'], guessed: ['measure_distance.home', 'measure_distance_home'], kind: 'number' },
  // The car's own "at home".
  atHome: {
    guessed: ['car_at_home', 'measure_polestarAtHome', 'at_home', 'measure_isHome', 'is_home'],
    kind: 'bool',
  },
  chargeLimit: { ids: ['charge_target_slow'], kind: 'limit' }, // AC charge limit (%) set in the car
  startCharge: { ids: ['charge'], kind: 'action', setable: 'strict' }, // tell the car to start charging
};

// Roles the user can choose at repair.
const CHOOSABLE = ['plugState', 'latitude', 'longitude', 'homeDistance', 'atHome', 'odometer', 'chargeLimit', 'startCharge'];

/**
 * Per role the capability to use: the user's choice when the device has it, else the first
 * automatic id it has (a guessed one only when it fits the role's kind).
 *
 * @param {object} device - HomeyAPI device: capabilities, capabilitiesObj
 * @param {object} table - role -> { ids, guessed, kind, setable }; setable true: not a read-only
 *   one, 'strict': only one that says it is setable
 * @param {object} [selected] - role -> capability id, 'auto' or 'none'
 * @returns {object} role -> capability id
 */
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

/**
 * Setup view rows (SourceCaps.roleItems) of the choosable roles, keyed `${prefix}${role}`.
 *
 * @param {object} auto - the resolved roles without a choice
 * @param {object} chosen - role -> the user's choice
 * @param {function} label - role key -> label
 */
const roleRows = (device, table, choosable, auto, chosen, prefix, label) => SourceCaps.roleItems(device,
  choosable.map((key) => ({ key, kind: table[key].kind, label: label(`${prefix}${key}`) })), auto, chosen)
  .map((item) => ({ ...item, key: `${prefix}${item.key}` }));

const resolveCarCaps = (car, selected = {}) => {
  const group = resolveRoles(car, CAR_CAPS, selected);
  const capsObj = (car && car.capabilitiesObj) || {};
  if (group.startCharge && capsObj[group.startCharge]?.setable !== true) delete group.startCharge;
  // Location needs both halves.
  if (!group.latitude || !group.longitude) {
    delete group.latitude;
    delete group.longitude;
  }
  return group;
};

const carCapRows = (car, chosen, label) => roleRows(car, CAR_CAPS, CHOOSABLE, resolveCarCaps(car), chosen, 'car_', label);

// Distance (km) for a car that only says it is not at home: away, without a location.
const AWAY_FLAG_KM = 10;

const KM_PER_UNIT = { m: 0.001, mi: 1.609344, miles: 1.609344 };

// A distance in the capability's units, in km.
const toKm = (value, units) => value * (KM_PER_UNIT[units] || 1);

const tmOf = (entry) => {
  const t = entry && entry.lastUpdated ? new Date(entry.lastUpdated).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * The car's distance from home, from its location, else its distance to home, else its own
 * "at home".
 *
 * @param {object} capsObj - the car's capabilitiesObj
 * @param {object} group - resolveCarCaps()
 * @param {object} home - { lat, lon } of Homey, or nulls
 * @returns {{km: number|null, tm: number|null, source: string|null}} tm: report time of the signal
 */
const carDistance = (capsObj, group, home = {}) => {
  const read = (cap) => (capsObj && cap && capsObj[cap] ? capsObj[cap] : null);
  // Number(null) is 0: a location not reported yet is no location.
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
