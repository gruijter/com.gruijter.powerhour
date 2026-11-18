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

const PriceDrivers = require('./PriceDrivers');

const FLOW_TYPES = ['trigger', 'condition', 'action'];

const ownDeviceIds = (homey) => new Set(Object.values(homey.drivers.getDrivers())
  .flatMap((driver) => driver.getDevices().map((d) => d.getId())));

const allFlows = async (api) => {
  const lists = await Promise.all([api.flow.getFlows(), api.flow.getAdvancedFlows()]);
  return lists.flatMap((list) => Object.values(list || {}));
};

const IMAGE_TTL_MS = 30 * 60 * 1000;
let imageScan = { tm: 0, ids: null };
const imageDeviceIds = (homey) => {
  if (imageScan.ids && Date.now() - imageScan.tm < IMAGE_TTL_MS) return imageScan.ids;
  const { api } = homey.app;
  if (!api) return Promise.resolve(null);
  const ids = allFlows(api).then((flows) => {
    const out = new Set();
    flows.filter((flow) => flow.enabled !== false).forEach((flow) => {
      for (const m of JSON.stringify(flow).matchAll(/homey:device:([\w-]+)\|image-/g)) out.add(m[1]);
    });
    return out;
  });
  imageScan = { tm: Date.now(), ids };
  ids.catch(() => {
    imageScan = { tm: 0, ids: null };
  });
  return ids;
};

const cardsOf = (flow) => {
  if (flow.cards) return Object.values(flow.cards).filter((c) => c && c.id && FLOW_TYPES.includes(c.type));
  return [
    flow.trigger && { ...flow.trigger, type: 'trigger' },
    ...(flow.conditions || []).map((c) => ({ ...c, type: 'condition' })),
    ...(flow.actions || []).map((c) => ({ ...c, type: 'action' })),
  ].filter((c) => c && c.id);
};

const appCards = async (homey) => {
  const { api } = homey.app;
  if (!api) return null;
  const appId = homey.manifest.id;
  const ownIds = ownDeviceIds(homey);
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

const quote = (names) => (names || []).map((name) => `'${name}'`).join(', ');

module.exports = {
  quote,
  ownDeviceIds,
  imageDeviceIds,
  allFlows,
  appCards,
  deprecatedCards,
  tariffFlows,
};
