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

const KINDS = {
  kwh: (id, obj) => obj.type === 'number' && (obj.units === 'kWh' || id.startsWith('meter_power')),
  w: (id, obj) => obj.type === 'number' && (obj.units === 'W' || id.startsWith('measure_power')),
  m3: (id, obj) => obj.type === 'number' && (['m³', 'm3'].includes(obj.units) || id.startsWith('meter_gas') || id.startsWith('meter_water')),
  pct: (id, obj) => obj.type === 'number' && (obj.units === '%' || id.startsWith('measure_battery')),
  number: (id, obj) => obj.type === 'number',
  limit: (id, obj) => obj.type === 'number' || (obj.type === 'enum'
    && (obj.values || []).some((v) => v.id !== '' && Number.isFinite(Number(v.id)))),
  action: (id, obj) => obj.type === 'boolean' && obj.setable === true,
  bool: (id, obj) => obj.type === 'boolean',
  plug: (id, obj) => obj.type === 'boolean' || (obj.type === 'enum'
    && (obj.values || []).some((v) => typeof v.id === 'string' && /plugged|connected/.test(v.id))),
  setA: (id, obj) => obj.type === 'number' && obj.setable === true && (obj.units === 'A' || (!obj.units && id.includes('current'))),
  setW: (id, obj) => obj.type === 'number' && obj.setable === true && (obj.units === 'W' || id.startsWith('target_power')),
};

const fits = (id, obj, kind) => !!obj && !!KINDS[kind] && KINDS[kind](id, obj);

const capsOfKind = (device, kind) => Object.entries((device && device.capabilitiesObj) || {})
  .filter(([id, obj]) => fits(id, obj, kind))
  .map(([id]) => id);

const hasKind = (device, kind) => capsOfKind(device, kind).length > 0;

const describe = (device, id) => {
  const obj = ((device && device.capabilitiesObj) || {})[id] || {};
  const value = obj.value === null || obj.value === undefined ? '' : `: ${obj.value}${obj.units ? ` ${obj.units}` : ''}`;
  return `${obj.title || id} (${id})${value}`;
};

const matchGroup = (caps, groups, meta = []) => (groups || []).find((group) => Object.keys(group)
  .filter((key) => !meta.includes(key) && group[key])
  .every((key) => caps.includes(group[key])));

const chosenFor = (stored, sourceId) => (stored && stored.sourceId === sourceId && stored.caps) || {};

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

const roleItems = (device, roles, auto, chosen = {}) => roles.map((role) => {
  const ids = capsOfKind(device, role.kind);
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
  matchGroup,
  describe,
  chosenFor,
  applyChoice,
  roleItems,
};
