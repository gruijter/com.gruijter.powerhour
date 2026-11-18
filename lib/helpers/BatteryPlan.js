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

const plannerFor = (advanced) => {
  // eslint-disable-next-line global-require
  return advanced ? require('../strategies/PrecisePlanner') : lightPlanner;
};

const solve = (device, options, group = null) => {
  const planStart = Date.now();
  const crashNotice = device.homey.app && device.homey.app.crashNotice;
  const advanced = !!device.getSettings().precisePlanning && !(crashNotice && crashNotice.lpKilled);
  const planner = plannerFor(advanced);
  let plan;
  if (options.idle) plan = lightPlanner.idlePlan(options);
  else if (!advanced) plan = group ? planner.planEach(options) : planner.plan(options);
  else {
    const names = (group || [device]).map((d) => d.getName());
    const run = () => (group ? planner.planEach(options) : planner.plan(options));
    plan = crashNotice ? crashNotice.run('lp', names, run) : run();
  }
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

const SOC_REPLAN_PCT = 2;
const socsClose = (planned, now) => !planned || (planned.length === now.length
  && planned.every((soc, i) => Math.abs(Number(soc) - Number(now[i])) < SOC_REPLAN_PCT));

const planInput = (device, minPriceDelta) => {
  const group = device.planGroup ? device.planGroup() : null;
  if (!group) {
    const options = device.buildPlanOptions(minPriceDelta);
    const { soc, startMinute, ...rest } = options;
    const slotMs = TimeHelpers.startOfLocalBlock(Date.now(), device.planIntervalMin(), device.timeZone || device.homey.clock.getTimezone());
    return {
      key: JSON.stringify([rest, slotMs]),
      socs: [soc],
      priceInterval: options.priceInterval,
      solve: () => solve(device, options, ''),
    };
  }
  const leader = group[0];
  const index = group.indexOf(device);
  const slotMs = TimeHelpers.startOfLocalBlock(Date.now(), leader.planIntervalMin(), leader.timeZone || leader.homey.clock.getTimezone());
  const memoKey = JSON.stringify([group.map((d) => [d.getData().id, d.getBatteryMode(), d.initTm]),
    leader.pricesUpdatedTm, slotMs]);
  const socs = group.map((d) => d.soc);
  if (!leader.groupPlans) leader.groupPlans = new Map();
  let entry = leader.groupPlans.get(minPriceDelta);
  if (!entry || entry.memoKey !== memoKey || !socsClose(entry.socs, socs)) {
    const source = leader.pricesNextHours ? leader : device;
    const options = source.buildPlanOptions(minPriceDelta, group);
    const key = JSON.stringify(options);
    entry = {
      memoKey, socs, options, key, plans: entry && entry.key === key ? entry.plans : null,
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

const cachedTokens = (device) => {
  const tokens = { ...device.lastPlanTokens };
  const elapsed = device.lastPlanTm ? (Date.now() - device.lastPlanTm) / 60000 : 0;
  if (tokens.duration > 0 && elapsed > 0) {
    tokens.duration = Math.max(0, Math.round(tokens.duration - elapsed));
    if (!tokens.duration) Object.assign(tokens, { power: 0, block: 'idle' });
  }
  return tokens;
};

const tokens = async (device, args, wait = true) => {
  const currentSessionId = device.sessionId;
  device.log(`[Plan] Requested for ${device.getName()} minPriceDelta:`, args.minPriceDelta);

  if (wait) await setTimeoutPromise(3000, device);

  if (device.sessionId !== currentSessionId) return null;
  if (!device.pricesNextHours) throw Error(device.homey.__('error_no_prices'));
  if (!device.priceInterval) throw Error(device.homey.__('error_no_price_interval'));

  const input = planInput(device, args.minPriceDelta);
  if (device.lastPlanKey === input.key && socsClose(device.lastPlanSocs, input.socs || [])) {
    device.log('[Plan] From cache', device.getName());
    const tokens = cachedTokens(device);
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
  device.lastPlanSocs = input.socs || null;
  device.lastPlanTokens = { ...tokens };
  device.lastPlanTm = Date.now();
  device.lastPlanMinPriceDelta = args.minPriceDelta;
  if (args.invert_power) tokens.power *= -1;
  return tokens;
};

module.exports = {
  tokens,
  cachedTokens,
  planInput,
  solve,
};
