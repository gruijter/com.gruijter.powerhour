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

const EvCarCaps = require('./EvCarCaps');

// Capabilities of the charger device to control and read. ids: Homey standard ids and ids
// confirmed in the app's source (com.zaptec: charging_button, alarm_generic.car_connected).
// guessed: ids of other charger apps in the Homey app store, by their manifest only: used when
// their type fits the kind (a setable current in A).
const CHARGER_CAPS = {
  // evcharger_charging is Homey's setable start/stop for the evcharger class; onoff covers smart plugs.
  switchCap: { ids: ['evcharger_charging', 'onoff', 'charging_button'], kind: 'action' },
  connState: { ids: ['evcharger_charging_state', 'alarm_generic.car_connected'], kind: 'plug' },
  powerCap: { ids: ['target_power'], kind: 'setW' },
  currentCap: {
    guessed: ['target_charger_current', 'evcharger_limit_current', 'current_limit', 'charge_current',
      'target_current', 'max_current', 'solax_evc_current_limit'],
    kind: 'setA',
  },
};

const CHOOSABLE = ['switchCap', 'connState', 'powerCap', 'currentCap'];

/**
 * @param {object} charger - HomeyAPI device
 * @param {object} [selected] - role -> capability id, 'auto' or 'none'
 * @returns {object} role -> capability id; switch, power and current only when setable
 */
const resolveChargerCaps = (charger, selected = {}) => {
  const group = EvCarCaps.resolveRoles(charger, CHARGER_CAPS, selected);
  const capsObj = (charger && charger.capabilitiesObj) || {};
  ['switchCap', 'powerCap', 'currentCap'].forEach((key) => {
    if (group[key] && capsObj[group[key]]?.setable === false) delete group[key];
  });
  return group;
};

const chargerCapOptions = (charger) => EvCarCaps.roleOptions(charger, CHARGER_CAPS, CHOOSABLE);

module.exports = {
  CHARGER_CAPS,
  CHOOSABLE,
  resolveChargerCaps,
  chargerCapOptions,
};
