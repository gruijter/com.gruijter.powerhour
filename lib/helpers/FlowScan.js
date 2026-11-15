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

// The cards of this app in the user's flows and advanced flows, via the Homey API. Card ids in a
// flow (Dev 2026-11-15): 'homey:app:<app id>:<card>', or 'homey:device:<device id>:<card>' for an
// app card with a device argument. Reads all flows: only on demand, never on a timer of minutes.

const PriceDrivers = require('./PriceDrivers');

const FLOW_TYPES = ['trigger', 'condition', 'action'];

// All flows and advanced flows.
const allFlows = async (api) => {
  const lists = await Promise.all([api.flow.getFlows(), api.flow.getAdvancedFlows()]);
  return lists.flatMap((list) => Object.values(list || {}));
};

const cardsOf = (flow) => {
  if (flow.cards) return Object.values(flow.cards).filter((c) => c && c.id && FLOW_TYPES.includes(c.type));
  return [
    flow.trigger && { ...flow.trigger, type: 'trigger' },
    ...(flow.conditions || []).map((c) => ({ ...c, type: 'condition' })),
    ...(flow.actions || []).map((c) => ({ ...c, type: 'action' })),
  ].filter((c) => c && c.id);
};

// [{ flow (name), card (id), type, args }] of this app in the enabled flows; null without the API.
const appCards = async (homey) => {
  const { api } = homey.app;
  if (!api) return null;
  const appId = homey.manifest.id;
  const ownIds = new Set(Object.values(await api.devices.getDevices())
    .filter((d) => String(d.driverId).includes(appId)).map((d) => d.id));
  const cards = [];
  (await allFlows(api)).filter((flow) => flow.enabled !== false).forEach((flow) => {
    cardsOf(flow).forEach((card) => {
      const parts = String(card.id).split(':');
      const own = (parts[1] === 'app' && parts[2] === appId) || (parts[1] === 'device' && ownIds.has(parts[2]));
      if (parts[0] !== 'homey' || parts.length !== 4 || !own) return;
      cards.push({
        flow: flow.name, card: parts[3], type: card.type, args: card.args || {},
      });
    });
  });
  return cards;
};

// The deprecated cards of the manifest by '<type>:<id>', without those of the old price drivers
// (MigrationNotice lists the flows of those devices).
const deprecatedCards = (manifest) => {
  const out = new Map();
  FLOW_TYPES.forEach((type) => {
    ((manifest.flow || {})[`${type}s`] || []).filter((card) => card.deprecated).forEach((card) => {
      const device = (card.args || []).find((arg) => arg.type === 'device');
      const drivers = device && /driver_id=([\w|]+)/.exec(device.filter || '');
      if (drivers && drivers[1].split('|').every((id) => PriceDrivers.OLD_DRIVER_IDS.includes(id))) return;
      out.set(`${type}:${card.id}`, card);
    });
  });
  return out;
};

// Names of the enabled flows that set the tariff of a commodity ('power', 'gas', 'water') with the old
// set_tariff_* cards: { [group]: [names] }. From appCards().
const tariffFlows = (cards, commodity) => {
  const groups = {};
  (cards || []).filter((c) => c.type === 'action' && c.card === `set_tariff_${commodity}`).forEach((c) => {
    const group = Number(c.args.group);
    if (!group) return;
    groups[group] = groups[group] || [];
    if (!groups[group].includes(c.flow)) groups[group].push(c.flow);
  });
  return groups;
};

// Flow names for a text: 'A', 'B' ('' for none).
const quote = (names) => (names || []).map((name) => `'${name}'`).join(', ');

module.exports = {
  quote,
  allFlows,
  appCards,
  deprecatedCards,
  tariffFlows,
};
