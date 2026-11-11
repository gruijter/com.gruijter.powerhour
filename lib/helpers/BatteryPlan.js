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

const lightPlanner = require('../strategies/LightPlanner');
const { setTimeoutPromise } = require('./Util');
const TimeHelpers = require('./TimeHelpers');

// The plan of a battery device: computed here, used by its control and charts (device
// updatePlan()) and by its flow cards (BatFlows).

// The LP (setting precisePlanning, more memory and CPU) or the light planner. The LP is
// loaded only when used.
const plannerFor = (advanced) => {
  // eslint-disable-next-line global-require
  return advanced ? require('../strategies/PrecisePlanner') : lightPlanner;
};

// group: the batteries of options.batteries, in that order; then a plan per battery.
const solve = (device, options, group = null) => {
  const planStart = Date.now();
  const advanced = !!device.getSettings().precisePlanning;
  const planner = plannerFor(advanced);
  let plan;
  if (options.idle) plan = lightPlanner.idlePlan(options);
  else plan = group ? planner.planEach(options) : planner.plan(options);
  // The planner saw each battery above its reserve: SoC back to the battery's.
  (group || [device]).forEach((d, i) => {
    if (typeof d.planSocToReal !== 'function') return;
    Object.values(group ? plan[i] : plan).forEach((slot) => {
      slot.soc = d.planSocToReal(slot.soc);
    });
  });
  const letters = (s) => Object.values(s).map((slot) => (slot.block || '-')[0]).join('');
  const blocks = group ? group.map((d, i) => `${d.getName()}: ${letters(plan[i])}`).join(' | ') : letters(plan);
  device.log(`[Plan] ${options.idle ? 'idle' : (advanced && 'LP') || 'light'}, ${group ? `group of ${group.length}, ` : ''}`
    + `${options.net ? 'grid forecast' : `fixed ${options.homePowerUsage} W`}, `
    + `${Object.keys(group ? plan[0] : plan).length} x ${options.priceInterval} min, ${Date.now() - planStart} ms: ${blocks}`);
  return plan;
};

// The plan input of this battery, and how to get its plan. Batteries this app controls in
// one mode are planned together (one LP, each with its own SoC, capacity, power and efficiency):
// the first of the group solves, each takes its own plan.
const planInput = (device, minPriceDelta) => {
  const group = device.planGroup ? device.planGroup() : null;
  if (!group) {
    const options = device.buildPlanOptions(minPriceDelta);
    return {
      key: JSON.stringify(options),
      priceInterval: options.priceInterval,
      solve: () => solve(device, options, ''),
    };
  }
  // Each flow card's minPriceDelta gets its own group plan. The options are built once per plan
  // slot for all members and cards: the members plan up to ~25 s apart (random delay in
  // triggerNewPlanFlow()).
  const leader = group[0];
  const index = group.indexOf(device);
  const slotMs = TimeHelpers.startOfLocalBlock(Date.now(), leader.planIntervalMin(), leader.timeZone || leader.homey.clock.getTimezone());
  // initTm: a member's (re)init, e.g. after a settings change.
  const memoKey = JSON.stringify([group.map((d) => [d.getData().id, d.soc, d.getBatteryMode(), d.initTm]),
    leader.pricesUpdatedTm, slotMs]);
  if (!leader.groupPlans) leader.groupPlans = new Map();
  let entry = leader.groupPlans.get(minPriceDelta);
  if (!entry || entry.memoKey !== memoKey) {
    // At the start a member can get its prices before the leader: the prices are of the group.
    const source = leader.pricesNextHours ? leader : device;
    const options = source.buildPlanOptions(minPriceDelta, group);
    const key = JSON.stringify(options);
    entry = {
      memoKey, options, key, plans: entry && entry.key === key ? entry.plans : null,
    };
    leader.groupPlans.set(minPriceDelta, entry);
  }
  return {
    key: `${index}|${entry.key}`,
    priceInterval: entry.options.priceInterval,
    solve: () => {
      if (!entry.plans) entry.plans = solve(leader, entry.options, group);
      return entry.plans[index];
    },
  };
};

/**
 * The plan as flow tokens { power, duration, endSoC, scheme, block }: the LP (setting
 * precisePlanning) or the light planner. From the cache when the plan input did not change.
 * @param {object} device - battery device
 * @param {object} args - { minPriceDelta, invert_power }
 * @param {boolean} [wait] - for new prices to be taken in
 */
const tokens = async (device, args, wait = true) => {
  const currentSessionId = device.sessionId;
  device.log(`[Plan] Requested for ${device.getName()} minPriceDelta:`, args.minPriceDelta);

  if (wait) await setTimeoutPromise(3000, device); // wait 3 seconds for new hourly prices to be taken in

  if (device.sessionId !== currentSessionId) return null;
  if (!device.pricesNextHours) throw Error(device.homey.__('error_no_prices'));
  if (!device.priceInterval) throw Error(device.homey.__('error_no_price_interval'));

  const input = planInput(device, args.minPriceDelta);
  if (device.lastPlanKey === input.key) {
    device.log('[Plan] From cache', device.getName());
    const tokens = { ...device.lastPlanTokens };
    if (args.invert_power) tokens.power *= -1;
    return tokens;
  }
  const plan = input.solve();
  const options = { priceInterval: input.priceInterval };

  let continuousDuration = plan[0] ? plan[0].duration : 0;
  let finalEndSoC = plan[0] ? plan[0].soc : device.soc;
  const firstPower = plan[0] ? plan[0].power : 0;
  const firstBlock = (plan[0] && plan[0].block) || 'idle';

  if (firstPower !== 0 && continuousDuration > 0) {
    const keys = Object.keys(plan).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < keys.length; i += 1) {
      const next = plan[keys[i]];
      if (!next || next.power !== firstPower || (next.block || 'idle') !== firstBlock) break;

      continuousDuration += next.duration;
      finalEndSoC = next.soc;

      if (next.duration < options.priceInterval) break;
    }
  }

  const tokens = {
    power: firstPower,
    duration: continuousDuration,
    endSoC: finalEndSoC,
    scheme: JSON.stringify(plan),
    block: firstBlock,
  };

  device.lastPlanKey = input.key;
  device.lastPlanTokens = { ...tokens };
  device.lastPlanTm = Date.now();
  device.lastPlanMinPriceDelta = args.minPriceDelta;
  if (args.invert_power) tokens.power *= -1;
  return tokens;
};

module.exports = {
  tokens,
  planInput,
  solve,
};
