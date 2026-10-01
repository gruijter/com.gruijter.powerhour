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

// Capabilities read from (or set on) the linked car device. 'Automatic' takes the first id of a
// role the car has: Homey standard ids plus ids confirmed in specific car apps (com.kia_hyundai:
// latitude/longitude, measure_odo, charge_target_slow, charge). For other car apps
// the user picks a capability per role at repair; the choice is kept in the device store.
const CAR_CAPS = {
  soc: ['measure_battery'],
  plugState: ['evcharger_charging_state', 'ev_charging_state'],
  plugBool: ['evcharger_charging'],
  latitude: ['latitude'],
  longitude: ['longitude'],
  odometer: ['measure_odo'],
  chargeLimit: ['charge_target_slow'], // AC charge limit (%) set in the car
  startCharge: ['charge'], // setable: tell the car to start charging
};

// Roles the user can choose at repair, with the kind of capability that fits.
const CHOOSABLE = {
  odometer: 'number',
  latitude: 'number',
  longitude: 'number',
  chargeLimit: 'limit', // a number, or an enum of numbers (com.kia_hyundai)
  startCharge: 'action',
};

const fits = (capObj, kind) => {
  if (!capObj) return false;
  if (kind === 'action') return capObj.type === 'boolean' && capObj.setable === true;
  if (kind === 'limit') {
    return capObj.type === 'number' || (capObj.type === 'enum'
      && (capObj.values || []).some((v) => v.id !== '' && Number.isFinite(Number(v.id))));
  }
  return capObj.type === kind;
};

/**
 * @param {object} car - HomeyAPI device: capabilities, capabilitiesObj
 * @param {object} [selected] - role -> capability id, 'auto' or 'none'
 * @returns {object} role -> capability id
 */
const resolveCarCaps = (car, selected = {}) => {
  const caps = (car && car.capabilities) || [];
  const capsObj = (car && car.capabilitiesObj) || {};
  const group = {};
  Object.entries(CAR_CAPS).forEach(([key, ids]) => {
    const choice = selected[key];
    if (choice === 'none') return;
    const cap = choice && choice !== 'auto' && caps.includes(choice) ? choice : ids.find((id) => caps.includes(id));
    if (cap) group[key] = cap;
  });
  if (group.startCharge && capsObj[group.startCharge]?.setable !== true) delete group.startCharge;
  // Location needs both halves.
  if (!group.latitude || !group.longitude) {
    delete group.latitude;
    delete group.longitude;
  }
  return group;
};

/**
 * Per choosable role, the car's capabilities that fit it.
 *
 * @returns {Array<{key, options: Array<{id, title, value, units}>, auto: string|null}>}
 */
const carCapOptions = (car) => {
  const capsObj = (car && car.capabilitiesObj) || {};
  const auto = resolveCarCaps(car);
  return Object.entries(CHOOSABLE).map(([key, kind]) => ({
    key,
    auto: auto[key] || null,
    options: Object.entries(capsObj)
      .filter(([, obj]) => fits(obj, kind))
      .map(([id, obj]) => ({
        id, title: obj.title || id, value: kind === 'action' ? null : obj.value, units: obj.units || '',
      })),
  }));
};

module.exports = {
  CAR_CAPS,
  CHOOSABLE,
  resolveCarCaps,
  carCapOptions,
};
