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

// Per role (e.g. import meter, state of charge), the capabilities of a source device that fit
// it, and the user's choice from the setup view applied on top of the automatic detection.
// The choice is kept in the device store as { sourceId, caps: { role: id | 'auto' | 'none' } }.

// By the units of the capability, or its id when an app leaves the units out.
const KINDS = {
  kwh: (id, obj) => obj.type === 'number' && (obj.units === 'kWh' || id.startsWith('meter_power')),
  w: (id, obj) => obj.type === 'number' && (obj.units === 'W' || id.startsWith('measure_power')),
  pct: (id, obj) => obj.type === 'number' && (obj.units === '%' || id.startsWith('measure_battery')),
};

const fits = (id, obj, kind) => !!obj && !!KINDS[kind] && KINDS[kind](id, obj);

// Capability ids of the device that fit the kind.
const capsOfKind = (device, kind) => Object.entries((device && device.capabilitiesObj) || {})
  .filter(([id, obj]) => fits(id, obj, kind))
  .map(([id]) => id);

const hasKind = (device, kind) => capsOfKind(device, kind).length > 0;

const describe = (device, id) => {
  const obj = ((device && device.capabilitiesObj) || {})[id] || {};
  const value = obj.value === null || obj.value === undefined ? '' : `: ${obj.value}${obj.units ? ` ${obj.units}` : ''}`;
  return `${obj.title || id} (${id})${value}`;
};

// The stored choice, when it was made for this source device.
const chosenFor = (stored, sourceId) => (stored && stored.sourceId === sourceId && stored.caps) || {};

/**
 * Apply the choice to the automatic group: an existing capability id replaces it, 'none' drops it.
 * @param {object} device - HomeyAPI device
 * @param {object} auto - role -> capability id (or null)
 * @param {string[]} roles - the choosable roles
 * @param {object} chosen - role -> capability id, 'auto' or 'none'
 * @returns {object} role -> capability id (or null)
 */
const applyChoice = (device, auto, roles, chosen = {}) => {
  const caps = (device && device.capabilities) || [];
  const group = { ...auto };
  roles.forEach((role) => {
    const choice = chosen[role];
    if (choice === 'none') group[role] = null;
    else if (choice && choice !== 'auto' && caps.includes(choice)) group[role] = choice;
  });
  return group;
};

/**
 * Setup view rows: per role the fitting capabilities, plus the automatic and chosen ones.
 * @param {object} device - HomeyAPI device
 * @param {Array<{key, kind, label}>} roles
 * @param {object} auto - role -> capability id (or null)
 * @param {object} chosen - role -> capability id, 'auto' or 'none'
 */
const roleItems = (device, roles, auto, chosen = {}) => roles.map((role) => {
  const ids = capsOfKind(device, role.kind);
  // Also the automatic and chosen ones when their units are unusual.
  [auto[role.key], chosen[role.key]].forEach((id) => {
    if (id && (device.capabilities || []).includes(id) && !ids.includes(id)) ids.push(id);
  });
  return {
    key: role.key,
    label: role.label,
    auto: auto[role.key] ? describe(device, auto[role.key]) : null,
    options: ids.map((id) => ({ id, label: describe(device, id) })),
    selected: chosen[role.key] || 'auto',
  };
});

module.exports = {
  fits,
  capsOfKind,
  hasKind,
  describe,
  chosenFor,
  applyChoice,
  roleItems,
};
