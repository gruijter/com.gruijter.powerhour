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
// Homey Energy counts this app's own devices as users too (double with their sources).
const { ownDeviceIds } = require('./FlowScan');
const MoneyUnit = require('./MoneyUnit');
const Stekker = require('../providers/Stekker');
const PriceLevels = require('./PriceLevels');
const PriceProfile = require('../strategies/PriceProfile');
const { slotLook } = require('../charts/ChargeChart');
const BatteryDayLog = require('./BatteryDayLog');
const TimeHelpers = require('./TimeHelpers');
const { findClosestSample, averageSamplesInWindow } = require('./HistoryLookup');

const SLOT_MS = 15 * 60 * 1000;
const PLAN_MIN_MS = 12 * 60 * 60 * 1000;
const PLAN_MAX_MS = 36 * 60 * 60 * 1000;

const devicesOf = (homey, driverId) => {
  try {
    return homey.drivers.getDriver(driverId).getDevices();
  } catch {
    return [];
  }
};

const avg = (values) => {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
};

// Power summarizers set as heating or cooling (setting climate).
const climateDevices = (homey) => devicesOf(homey, 'power').filter((d) => d.getSettings().climate === true);

const sumCap = (devs, cap) => devs.reduce((total, d) => total + (d.getCapabilityValue(cap) || 0), 0);

const capOf = (d, cap) => (d.hasCapability(cap) && typeof d.getCapabilityValue(cap) === 'number' ? d.getCapabilityValue(cap) : null);

// Per EV: name, SoC now (null in energy mode) and away/home/plugged_in/charging.
const evInfo = (d) => ({
  name: d.getName(),
  soc: capOf(d, 'measure_ev_soc'),
  state: d.hasCapability('ev_car_state') ? d.getCapabilityValue('ev_car_state') : null,
});

// The gas or water meters of the home: those on the grid's own source device (the smart meter);
// without one all of them (a submeter, such as one on the boiler, would else count twice).
const mainMeters = (homey, driverId, grid) => {
  const devs = devicesOf(homey, driverId);
  const source = grid.getSettings().homey_device_id;
  const same = source ? devs.filter((d) => d.getSettings().homey_device_id === source) : [];
  return same.length ? same : devs;
};

// The live flows of widgets/energy (period now). W, signed as on the Grid Monitor: grid + import,
// battery + charging, EV + charging (− V2X discharging).
const getFlow = (homey) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid) return { grid: null };
  const val = (cap) => Math.round(grid.getCapabilityValue(cap) || 0);
  const gridW = val('measure_watt_grid');
  const solarW = Math.max(0, val('measure_watt_solar'));
  const batteryW = val('measure_watt_battery');
  const evW = val('measure_watt_evcharger'); // negative: V2X discharging
  const batteries = devicesOf(homey, 'battery');
  const evs = devicesOf(homey, 'evCharger');
  const report = grid.driver && grid.driver.lastEnergyReport;
  const hasSolar = devicesOf(homey, 'solar').length > 0
    || !!(report && report.totalGenerated && typeof report.totalGenerated.W === 'number');
  const climate = climateDevices(homey);
  const climateW = climate.length ? Math.round(sumCap(climate, 'measure_watt_avg')) : null;
  const gas = mainMeters(homey, 'gas', grid).filter((d) => d.hasCapability('measure_gas'));
  const water = mainMeters(homey, 'water', grid).filter((d) => d.hasCapability('measure_water'));
  return {
    currency: MoneyUnit.get(grid).currency,
    grid: gridW,
    solar: hasSolar ? solarW : null,
    battery: batteries.length ? batteryW : null,
    batterySoc: avg(batteries.map((d) => d.soc)),
    ev: evs.length ? evW : null,
    evs: evs.map((d) => ({ ...evInfo(d), w: Math.round(capOf(d, 'measure_watt_avg') || 0) })),
    climate: climateW,
    // L/min, averaged from the gas meter (the widget converts with its kWh per m³).
    gasLpm: gas.length ? sumCap(gas, 'measure_gas') : null,
    waterLpm: water.length ? sumCap(water, 'measure_water') : null,
    // Unsmoothed balance without climate, so the flows add up; timing skew can make it negative.
    home: Math.max(0, gridW + solarW - batteryW - evW - (climateW || 0)),
  };
};

// The price list of the grid's tariff group, finest interval first.
const groupPrices = (homey, grid) => {
  const group = grid.getSettings().tariff_update_group;
  const dev = PriceDrivers.getDevices(homey, { commodity: 'power' })
    .filter((d) => d.getSettings().tariff_update_group === group && Array.isArray(d.prices) && d.prices.some((p) => p && p.time))
    .sort((a, b) => (a.priceInterval || 60) - (b.priceInterval || 60))[0];
  if (!dev) return null;
  const settings = dev.getSettings();
  return {
    intervalMs: (dev.priceInterval || 60) * 60 * 1000,
    currency: settings.currency || '€',
    levels: PriceLevels.ofDevice(dev),
    list: dev.prices.filter((p) => p && p.time).map((p) => ({
      t: new Date(p.time).getTime(),
      price: typeof p.muPrice === 'number' ? p.muPrice : p.price,
      forecast: !!p.isForecast,
    })).sort((a, b) => a.t - b.t),
  };
};

// Planned SoC (%) per slot of a charge device's latest plan, as getPlannedPowerSeries() maps it.
const plannedSoc = (dev, startMs, n) => {
  const plan = dev.latestPlan;
  return Array.from({ length: n }, (_, i) => {
    if (!plan) return null;
    const idx = Math.floor((startMs + i * SLOT_MS - plan.startMs) / plan.intervalMs);
    const slot = idx >= 0 ? plan.slots[idx] : null;
    return slot && typeof slot.soc === 'number' ? slot.soc : null;
  });
};

// The combined plan of widgets/plan: per 15-minute slot from now to the end of the known prices
// The combined plan of widgets/plan per 15-minute slot. next: from now to the end of the known
// prices (12-36 h); today and tomorrow: the local day, today measured before now (as the charge charts).
// W as getNetForecast(): battery + charge, net + import.
const PLAN_DAYS = ['next', 'today', 'tomorrow'];
const getPlan = (homey, day) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid || typeof grid.getNetForecast !== 'function') return { grid: null };
  const which = PLAN_DAYS.includes(day) ? day : 'next';
  const tz = grid.timeZone || homey.clock.getTimezone();
  const nowSlot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  const prices = groupPrices(homey, grid);
  let startMs = nowSlot;
  let endMs;
  if (which === 'next') {
    const priceEnd = prices && prices.list.length
      ? prices.list[prices.list.length - 1].t + prices.intervalMs : startMs + 24 * 60 * 60 * 1000;
    endMs = startMs + Math.min(PLAN_MAX_MS, Math.max(PLAN_MIN_MS, Math.ceil((priceEnd - startMs) / SLOT_MS) * SLOT_MS));
  } else {
    const today = TimeHelpers.getLocalMidnightUTC(new Date(), tz).getTime();
    const tomorrow = TimeHelpers.getLocalMidnightUTC(new Date(today + 26 * 3600000), tz).getTime();
    startMs = which === 'today' ? today : tomorrow;
    endMs = which === 'today' ? tomorrow : TimeHelpers.getLocalMidnightUTC(new Date(tomorrow + 26 * 3600000), tz).getTime();
  }
  const n = Math.round((endMs - startMs) / SLOT_MS);
  // Slots before now: measured; from now on: the forecast and plans.
  const past = Math.max(0, Math.min(n, Math.round((nowSlot - startMs) / SLOT_MS)));
  const f = past < n ? grid.getNetForecast(startMs + past * SLOT_MS, endMs) : null;
  const times = Array.from({ length: n }, (_, i) => startMs + i * SLOT_MS);
  const series = (measured, planned) => times.map((t, i) => {
    if (i < past) return measured(t);
    return planned ? planned[i - past] : null;
  });
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const mean = (list, t, key) => round(averageSamplesInWindow(list, t, t + SLOT_MS, key));
  const sumOf = (devs, fn) => (t) => {
    const vals = devs.map((d) => fn(d, t)).filter((v) => typeof v === 'number');
    return vals.length ? round(vals.reduce((a, v) => a + v, 0)) : null;
  };

  const entries = times.map((t) => prices && prices.list.find((p) => p.t <= t && t < p.t + prices.intervalMs));
  const price = entries.map((e) => (e && typeof e.price === 'number' ? e.price : null));
  const solars = devicesOf(homey, 'solar');
  const batteries = devicesOf(homey, 'battery');
  const evs = devicesOf(homey, 'evCharger');
  const futureStart = startMs + past * SLOT_MS;
  const socs = batteries.map((d) => plannedSoc(d, futureStart, n - past));
  // A car without SoC (energy mode) has no SoC plan.
  const socEvs = evs.filter((d) => !(typeof d._energyMode === 'function' && d._energyMode()));
  const evSocs = socEvs.map((d) => plannedSoc(d, futureStart, n - past));
  const socOf = (devs, plans) => series(
    (t) => avg(devs.map((d) => (typeof d.getActualSocForTime === 'function' ? d.getActualSocForTime(t) : null))),
    Array.from({ length: n - past }, (_, i) => avg(plans.map((s) => s[i]))),
  );
  const appliances = typeof grid.getApplianceDevices === 'function' ? grid.getApplianceDevices() : [];
  const actual = (d, t) => (typeof d.getActualPowerForTime === 'function' ? d.getActualPowerForTime(t) : null);

  return {
    grid: true,
    day: which,
    timeZone: tz,
    startMs,
    slotMs: SLOT_MS,
    past, // slots before now (measured)
    currency: prices ? prices.currency : null,
    price: prices ? price : null, // with a price device also when none are known yet (the widget keeps its lanes)
    priceForecast: entries.map((e) => !!(e && e.forecast)), // expected, not yet known prices
    priceLevel: entries.map((e) => (e && prices.levels.has(e.t) ? prices.levels.get(e.t).level : null)), // free, cheap, normal or dear
    priceAlpha: entries.map((e) => (e && prices.levels.has(e.t) ? prices.levels.get(e.t).alpha : 1)), // within lowest/highest
    solar: solars.length ? series(sumOf(solars, (d, t) => mean(d.powerHistory, t, 'power')), f && f.solar) : null,
    home: series((t) => mean(grid.powerHistory, t, 'power'), f && f.load),
    battery: batteries.length ? series(sumOf(batteries, actual), f && f.battery) : null,
    soc: batteries.length ? socOf(batteries, socs) : null,
    ev: evs.length ? series(sumOf(evs, actual), f && f.ev) : null,
    evSoc: socEvs.length ? socOf(socEvs, evSocs) : null,
    appliances: appliances.map((d) => {
      const slots = new Map((d.applianceSlots || []).map((e) => [e.t, Math.round(e.kwh * 4000)]));
      const ahead = past < n ? (d.getForecastSeries(futureStart, endMs) || []) : [];
      return { name: d.getName(), w: series((t) => slots.get(t) || 0, ahead).map((v) => Math.round(v || 0)) };
    }),
    net: series((t) => mean(grid.powerHistory, t, 'grid'), f && f.netPlanned),
  };
};

const PERIODS = ['hour', 'day', 'month', 'year'];

// kWh and money since the start of this period (hour/day/month/year) of widgets/energy. Import/export
// split and battery charged/discharged only with that data; gas and water in m³ (the widget converts
// gas). Money as the meters keep it: grid, EV, gas, water and climate costs; solar value and battery
// profit negated.
const getEnergy = (homey, period) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid) return { grid: null };
  const p = PERIODS.includes(period) ? period : 'day';
  const sumOf = (all, cap) => {
    const devs = all.filter((d) => d.hasCapability(cap));
    return devs.length ? sumCap(devs, cap) : null;
  };
  const sum = (driverId, cap) => sumOf(devicesOf(homey, driverId), cap);
  const gas = mainMeters(homey, 'gas', grid);
  const water = mainMeters(homey, 'water', grid);
  const batteries = devicesOf(homey, 'battery');
  const climate = climateDevices(homey);
  const climateKwh = climate.length ? sumCap(climate, `meter_kwh_this_${p}`) : null;
  const money = `meter_money_this_${p}`;
  const negate = (v) => (typeof v === 'number' ? -v : v);
  return {
    grid: true,
    period: p,
    net: grid.getCapabilityValue(`meter_kwh_this_${p}`) || 0,
    imported: capOf(grid, `meter_kwh_this_${p}.imported`),
    exported: capOf(grid, `meter_kwh_this_${p}.exported`),
    // The home without climate; the climate meters can run ahead of the home counter.
    home: typeof capOf(grid, `meter_kwh_this_${p}.home`) === 'number' ? Math.max(0, capOf(grid, `meter_kwh_this_${p}.home`) - (climateKwh || 0)) : null,
    climate: climateKwh,
    solar: sum('solar', `meter_kwh_this_${p}`),
    charged: sumOf(batteries, `meter_kwh_this_${p}.charged`),
    discharged: sumOf(batteries, `meter_kwh_this_${p}.discharged`),
    ev: sum('evCharger', `meter_kwh_this_${p}`),
    // Per EV; charged and discharged apart only with V2X, like the battery.
    evs: devicesOf(homey, 'evCharger').map((d) => {
      const v2x = typeof capOf(d, `meter_kwh_this_${p}.discharged`) === 'number';
      return {
        ...evInfo(d),
        kwh: capOf(d, `meter_kwh_this_${p}`),
        money: capOf(d, money),
        charged: v2x ? capOf(d, `meter_kwh_this_${p}.charged`) : null,
        discharged: v2x ? capOf(d, `meter_kwh_this_${p}.discharged`) : null,
      };
    }),
    gasM3: sumOf(gas, `meter_m3_this_${p}`),
    waterM3: sumOf(water, `meter_m3_this_${p}`),
    money: {
      ...MoneyUnit.get(grid),
      grid: grid.hasCapability(money) ? grid.getCapabilityValue(money) || 0 : null,
      // Solar value and battery profit: negative here, like the grid (+ = paid).
      solar: negate(sum('solar', money)),
      battery: negate(sum('battery', money)),
      ev: sum('evCharger', money),
      gas: sumOf(gas, money),
      water: sumOf(water, money),
      climate: climate.length ? sumCap(climate, money) : null,
    },
  };
};

// A user's ids: its own and that of the source device it meters (its zone is the source's zone).
const userIds = (d) => ({ id: d.getId(), sourceId: d.getSettings().homey_device_id || null });

// widgets/flows: the flows of widgets/energy as a Sankey diagram, with more single users. W (period
// now) or kWh since the start of the period; gas in L/min or m³ (the widget converts with its kWh per
// m³). Sources: grid import, solar, battery and EV (V2X) discharging. Destinations: export, battery
// charging, each EV, each climate summarizer and the home without those (home); users: the devices
// chosen in the widget (ids, Homey device ids in that order; none: all), Power Summarizers without climate
// role.
const getFlows = (homey, period, ids) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid) return { grid: null };
  const live = period === 'now';
  const p = PERIODS.includes(period) ? period : 'day';
  const pos = (v) => Math.max(0, v || 0);
  const evDevs = devicesOf(homey, 'evCharger');
  const climate = climateDevices(homey);
  const rank = (d) => {
    const i = ids.indexOf(d.getId());
    return i >= 0 ? i : ids.indexOf(typeof d.getAppId === 'function' ? d.getAppId() : null);
  };
  // Nothing chosen: all, except climate summarizers (under climate) and those fed by Homey Energy itself
  // (such as its solar total: no user).
  const chosen = devicesOf(homey, 'power')
    .filter((d) => d.getSettings().climate !== true && (ids.length ? rank(d) >= 0 : !d.getSettings().homey_energy))
    .sort((a, b) => rank(a) - rank(b));
  const out = {
    grid: true, live, sources: [], exported: 0, batteryCharge: null, evs: [], climate: [], home: 0, users: [], gas: null,
  };
  if (live) {
    const f = getFlow(homey);
    out.sources.push({ key: 'grid', value: pos(f.grid) });
    out.exported = pos(-f.grid);
    if (f.solar !== null) out.sources.push({ key: 'solar', value: pos(f.solar) });
    if (f.battery !== null) {
      out.sources.push({ key: 'battery', value: pos(-f.battery) });
      out.batteryCharge = pos(f.battery);
    }
    const w = (d) => capOf(d, 'measure_watt_avg') || 0;
    out.sources.push({ key: 'ev', value: evDevs.reduce((sum, d) => sum + pos(-w(d)), 0) });
    out.evs = evDevs.map((d) => ({ name: d.getName(), value: pos(w(d)) }));
    out.climate = climate.map((d) => ({ name: d.getName(), value: pos(w(d)) }));
    out.home = pos(f.home);
    out.users = chosen.map((d) => ({ ...userIds(d), name: d.getName(), value: pos(w(d)) }));
    out.gas = f.gasLpm;
  } else {
    const e = getEnergy(homey, p);
    const split = typeof e.imported === 'number' && typeof e.exported === 'number';
    out.sources.push({ key: 'grid', value: split ? e.imported : pos(e.net) });
    out.exported = split ? e.exported : pos(-e.net);
    if (e.solar !== null) out.sources.push({ key: 'solar', value: pos(e.solar) });
    if (e.charged !== null && e.discharged !== null) {
      out.sources.push({ key: 'battery', value: pos(e.discharged) });
      out.batteryCharge = pos(e.charged);
    }
    out.sources.push({ key: 'ev', value: e.evs.reduce((sum, ev) => sum + pos(ev.discharged), 0) });
    out.evs = e.evs.map((ev) => ({ name: ev.name, value: pos(typeof ev.charged === 'number' ? ev.charged : ev.kwh) }));
    const kwh = (d) => pos(capOf(d, `meter_kwh_this_${p}`));
    out.climate = climate.map((d) => ({ name: d.getName(), value: kwh(d) }));
    out.home = pos(e.home);
    out.users = chosen.map((d) => ({ ...userIds(d), name: d.getName(), value: kwh(d) }));
    out.gas = e.gasM3;
  }
  out.sources = out.sources.filter((src) => src.key !== 'ev' || src.value > 0);
  return out;
};

const ZONE_TTL = 10 * 60 * 1000;
let zoneCache = { tm: 0, zones: {}, devices: {} };

// The order of the zones as in Homey: the zone tree depth-first, siblings by sortIndex, then name.
// { zoneId: rank }, cached with the zones.
const zoneOrder = () => {
  if (zoneCache.order) return zoneCache.order;
  const zones = Object.values(zoneCache.zones);
  const kids = (parent) => zones.filter((z) => (z.parent || null) === parent)
    .sort((a, b) => ((a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity)) || String(a.name).localeCompare(String(b.name)));
  const order = {};
  let rank = 0;
  const walk = (parent) => kids(parent).forEach((z) => {
    order[z.id] = rank;
    rank += 1;
    walk(z.id);
  });
  walk(null);
  zoneCache.order = order;
  return order;
};

// Zones of devices (Homey device ids) for widgets/flows: { id, name } or null. The SDK has no zone of a
// device: via the app's Homey API, cached 10 minutes (no API calls on every 5 s refresh). Unknown or
// no device (a virtual source such as Homey Energy): null.
const deviceZones = async (homey, ids) => {
  const api = homey.app && homey.app.api;
  if (!api || !ids.length) return {};
  if (Date.now() - zoneCache.tm > ZONE_TTL) {
    zoneCache = { tm: Date.now(), zones: (await api.zones.getZones().catch(() => null)) || {}, devices: {} };
  }
  const out = {};
  for (const id of ids) {
    if (!(id in zoneCache.devices)) {
      // eslint-disable-next-line no-await-in-loop
      const dev = await api.devices.getDevice({ id }).catch(() => null);
      zoneCache.devices[id] = dev ? dev.zone : null;
    }
    const zone = zoneCache.zones[zoneCache.devices[id]];
    out[id] = zone && zone.name
      ? { id: zone.id || zoneCache.devices[id], name: zone.name, order: zoneOrder()[zone.id || zoneCache.devices[id]] } : null;
  }
  return out;
};

// Ids of the Homey devices this app's devices meter (their sources), that are shown as that PbtH device:
// not again as a Homey device. A Power Summarizer without climate role is only shown when it is a user
// (shownIds); when it is not, its source may show as a Homey device.
const sourceDeviceIds = (homey, shownIds) => {
  const ids = new Set();
  Object.entries(homey.drivers.getDrivers()).forEach(([driverId, driver]) => driver.getDevices().forEach((d) => {
    const settings = d.getSettings();
    if (!settings.homey_device_id) return;
    if (driverId === 'power' && settings.climate !== true && !shownIds.has(d.getId())) return;
    ids.add(settings.homey_device_id);
  }));
  return ids;
};

// All zone ids (cached with the device zones).
const allZoneIds = async (homey) => {
  await deviceZones(homey, ['-']);
  return Object.keys(zoneCache.zones);
};

// The date parts of now in the Homey's time zone, for the Homey Energy reports.
const localParts = (homey) => {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: homey.clock.getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).forEach((x) => {
    parts[x.type] = x.value;
  });
  return parts;
};

// Homey Energy usage per zone (zone ids) of the devices directly in it (not its sub-zones), without this
// app's devices, and per device: W now (live report per zone, 30 s cache) or kWh this day/month/year
// (report per device, summed per zone, 60 s cache): { totals: { zoneId: value }, devices: { id: { name,
// value } } }. No hour report: null.
const zoneTotalCache = {};
const homeyZoneTotals = async (homey, period, zoneIds) => {
  const api = homey.app && homey.app.api;
  if (!api || !api.energy || !zoneIds.length || period === 'hour') return null;
  const key = `${period}:${zoneIds.slice().sort().join(',')}`;
  const ttl = period === 'now' ? 30000 : 60000;
  const hit = zoneTotalCache[key];
  if (hit && Date.now() - hit.tm < ttl) return hit.result;
  const own = ownDeviceIds(homey);
  const totals = {};
  const devices = {};
  if (period === 'now') {
    for (const zone of zoneIds) {
      // eslint-disable-next-line no-await-in-loop
      const report = await api.energy.getLiveReport({ zone }).catch(() => null);
      if (!report) continue;
      // The devices directly in this zone (a sub-zone has its own total), without this app's devices.
      let sum = 0;
      (report.items || []).filter((i) => i.type === 'device' && !own.has(i.id)).forEach((i) => {
        const w = Math.max(0, (i.values && i.values.W) || 0);
        devices[i.id] = { name: i.name, value: w };
        sum += w;
      });
      totals[zone] = sum;
    }
  } else {
    const t = localParts(homey);
    let report = null;
    if (period === 'day') report = await api.energy.getReportDay({ date: `${t.year}-${t.month}-${t.day}` }).catch(() => null);
    if (period === 'month') report = await api.energy.getReportMonth({ yearMonth: `${t.year}-${t.month}` }).catch(() => null);
    if (period === 'year') report = await api.energy.getReportYear({ year: t.year }).catch(() => null);
    const consumed = report && report.electricity && report.electricity.devices && report.electricity.devices.consumed;
    if (!consumed) return null;
    const used = Object.entries(consumed).filter(([id, v]) => !own.has(id) && v && v.period > 0);
    const zones = await deviceZones(homey, used.map(([id]) => id));
    used.forEach(([id, v]) => {
      devices[id] = { name: v.name, value: v.period };
      const z = zones[id];
      if (z && zoneIds.includes(z.id)) totals[z.id] = (totals[z.id] || 0) + v.period;
    });
  }
  const result = { totals, devices };
  zoneTotalCache[key] = { tm: Date.now(), result };
  return result;
};

const SOLAR_DAYS = ['yesterday', 'today', 'tomorrow', 'weeks', 'year'];

const localKey = (ms, timeZone) => new Date(ms).toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
const doyOf = (y, m, d) => Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);

// One period of the solar widget: { kwh, own (kWh used at home), money, est (estimated) }: the sum of
// its parts. Own use or money unknown for a part: unknown, or with partial, scaled from the parts
// that have it when they hold at least half the kWh (estimated).
const sumPeriods = (parts, partial = false) => {
  const known = parts.filter((p) => p && typeof p.kwh === 'number');
  if (!known.length) return null;
  const kwh = known.reduce((a, p) => a + p.kwh, 0);
  let est = known.some((p) => p.est);
  const sumOf = (field) => {
    const has = known.filter((p) => typeof p[field] === 'number' || (field === 'own' && p.kwh <= 0));
    const value = has.reduce((a, p) => a + (p[field] || 0), 0);
    if (has.length === known.length) return value;
    const hasKwh = has.reduce((a, p) => a + p.kwh, 0);
    if (!partial || !(hasKwh > 0) || hasKwh < 0.5 * kwh) return null;
    est = true;
    return (value * kwh) / hasKwh;
  };
  const own = sumOf('own');
  const money = sumOf('money');
  return {
    kwh, own, money, est,
  };
};

// Today from a device's meters.
const todayOf = (d) => {
  const kwh = capOf(d, 'meter_kwh_this_day');
  const pct = capOf(d, 'measure_solar_use.this_day');
  return typeof kwh === 'number' ? {
    kwh, own: typeof pct === 'number' ? (kwh * pct) / 100 : null, money: capOf(d, 'meter_money_this_day'), est: false,
  } : null;
};

// A day (YYYY-MM-DD) of the devices: today from their meters, else from their day logs.
const solarDay = (devs, key, todayKey) => {
  if (key === todayKey) return sumPeriods(devs.map(todayOf));
  const [y, m, d] = key.split('-').map(Number);
  return sumPeriods(devs.map((dev) => (typeof dev.loggedDay === 'function' ? dev.loggedDay(y, doyOf(y, m - 1, d)) : null)));
};

// A month of the year: its days; where days lack own use or value, the devices' month share and
// value per kWh (exact from Insights), else unknown.
const solarMonth = (devs, year, m, lastDay, todayKey) => {
  const pad = (n) => String(n).padStart(2, '0');
  const perDevice = devs.map((dev) => {
    const days = [];
    for (let day = 1; day <= lastDay; day += 1) days.push(solarDay([dev], `${year}-${pad(m + 1)}-${pad(day)}`, todayKey));
    const sum = sumPeriods(days);
    if (!sum) return null;
    const scaled = sumPeriods(days, true);
    const log = dev.dayLog && dev.dayLog.v === 2 && dev.dayLog.year === year ? dev.dayLog : null;
    if (sum.own === null && log && log.mShare[m] >= 0) sum.own = sum.kwh * log.mShare[m];
    if (sum.money === null && log && log.mValue[m] >= 0) sum.money = sum.kwh * log.mValue[m];
    // Else from the days that have it (>= half the kWh), estimated.
    ['own', 'money'].forEach((field) => {
      if (sum[field] === null && typeof scaled[field] === 'number') {
        sum[field] = scaled[field];
        sum.est = true;
      }
    });
    return sum;
  });
  return sumPeriods(perDevice);
};

// widgets/solar: the chosen solar devices (none chosen or none found: all) added up. Every tab and
// every slot or bar has the same fields: { kwh, own, money, est }. Days: forecast and measured W per
// 15 minutes over the sun hours (the chart images), own use share per slot from the 48 h histories
// (1 - export / solar, the live split); weeks: the last 28 days; year: per month. building: the
// history is still being rebuilt from Insights.
const getSolar = (homey, day, ids = []) => {
  const present = devicesOf(homey, 'solar');
  const all = present.filter((d) => typeof d.solarDay === 'function' && d.forecastHistory);
  const chosen = all.filter((d) => ids.includes(d.getId()));
  const devs = chosen.length ? chosen : all;
  // false: solar devices still starting; null: none.
  if (!devs.length) return { solar: present.length ? false : null };
  const which = SOLAR_DAYS.includes(day) ? day : 'today';
  const timeZone = homey.clock.getTimezone();
  const todayKey = localKey(Date.now(), timeZone);
  const [year, month, dayNr] = todayKey.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const out = {
    solar: true,
    day: which,
    timeZone,
    count: devs.length,
    ...MoneyUnit.get(devs[0]),
    building: devs.some((d) => typeof d.historyPending === 'function' && d.historyPending()),
  };
  if (which === 'weeks') {
    const bars = Array.from({ length: 28 }, (_, i) => {
      const date = new Date(Date.UTC(year, month - 1, dayNr - 27 + i));
      const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      return { ...(solarDay(devs, key, todayKey) || {}), date: key };
    });
    return { ...out, bars, total: sumPeriods(bars, true) };
  }
  if (which === 'year') {
    const bars = Array.from({ length: 12 }, (_, m) => {
      if (m + 1 > month) return null;
      const last = m + 1 === month ? dayNr : new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
      return solarMonth(devs, year, m, last, todayKey);
    });
    return { ...out, bars, total: sumPeriods(bars, true) };
  }
  let total = null;
  if (which === 'today') total = sumPeriods(devs.map(todayOf));
  if (which === 'yesterday') total = solarDay(devs, localKey(Date.now() - 86400000, timeZone), todayKey);
  const bounds = devs.map((d) => d.solarDayBounds(which)).filter(Boolean);
  if (!bounds.length) return { ...out, total, forecast: null };
  const range = {
    start: new Date(Math.min(...bounds.map((b) => b.start.getTime()))),
    end: new Date(Math.max(...bounds.map((b) => b.end.getTime()))),
  };
  const series = devs.map((d) => d.solarDay(which, range)).filter(Boolean);
  if (!series.length) return { ...out, total, forecast: null };
  const n = Math.min(...series.map((x) => x.times.length));
  const forecast = [];
  const real = [];
  for (let i = 0; i < n; i += 1) {
    forecast.push(series.reduce((a, x) => a + (x.forecast[i] || 0), 0));
    const measured = series.map((x) => x.real[i]).filter((v) => typeof v === 'number');
    real.push(measured.length ? Math.round(measured.reduce((a, v) => a + v, 0)) : null);
  }
  // Own use share per measured slot from histories already kept (48 h): grid + import, - export.
  const grid = devicesOf(homey, 'grid')[0];
  const gridHistory = grid && Array.isArray(grid.powerHistory) ? grid.powerHistory : null;
  const own = which === 'tomorrow' || !gridHistory ? null : series[0].times.slice(0, n).map((t, i) => {
    if (!(real[i] > 0)) return null;
    const g = findClosestSample(gridHistory, t, 10 * 60 * 1000, 'grid');
    return typeof g === 'number' ? Math.round(Math.min(1, Math.max(0, 1 - Math.max(0, -g) / real[i])) * 1000) / 1000 : null;
  });
  return {
    ...out,
    total,
    startMs: series[0].times[0],
    slotMs: SLOT_MS,
    forecast,
    real,
    own,
    peak: devs.reduce((a, d) => a + (d.chartPeak() || 0), 0),
    expectedKwh: forecast.reduce((a, v) => a + v, 0) / 4000,
    nowW: which === 'today' ? sumCap(devs.filter((d) => typeof capOf(d, 'measure_power') === 'number'), 'measure_power') : null,
  };
};

// widgets/price: the prices of one day (today or tomorrow) of the chosen price device, else the
// electricity price device of the grid's tariff group. Per price interval: import, export (when the
// device shows its export line), expected (not yet known). price false: no prices yet; null: no device.
const PRICE_DAYS = ['today', 'tomorrow', 'next'];
const priceDevice = (homey, ids) => {
  const all = PriceDrivers.getDevices(homey);
  const grid = devicesOf(homey, 'grid')[0];
  const group = grid ? grid.getSettings().tariff_update_group : null;
  const power = all.filter((d) => d.hasExport).sort((a, b) => (a.driver.id === 'price' ? 0 : 1) - (b.driver.id === 'price' ? 0 : 1));
  return all.find((d) => ids.includes(d.getId()))
    || power.find((d) => d.getSettings().tariff_update_group === group) || power[0] || all[0];
};

// Forecast prices can be turned on here (off only via repair): a market electricity price device
// without them, in a zone of the forecast provider.
const canForecast = (dev) => {
  const settings = dev.getSettings();
  if (dev.driver.id !== 'price' || !dev.hasExport || settings.forecastEnable || settings.tariffType === 'fixed') return false;
  const zones = new Stekker().getBiddingZones();
  return Object.values(zones).some((z) => z.includes(settings.biddingZone));
};

const enableForecast = async (homey, ids = []) => {
  const dev = priceDevice(homey, ids);
  if (!dev || !canForecast(dev)) return false;
  await dev.applySetup({ forecastEnable: true });
  return true;
};

const getPrice = (homey, day, ids = []) => {
  const dev = priceDevice(homey, ids);
  if (!dev) return { price: null };
  if (!Array.isArray(dev.prices) || !dev.priceInterval || typeof dev.getUTCPeriods !== 'function') return { price: false };
  const which = PRICE_DAYS.includes(day) ? day : 'today';
  const periods = dev.getUTCPeriods();
  const slotMs = dev.priceInterval * 60 * 1000;
  const byTime = new Map();
  dev.prices.forEach((p) => {
    if (p && p.time) byTime.set(new Date(p.time).getTime(), p);
  });
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const settings = dev.getSettings();
  const showExport = dev.hasExport && !!settings.export_show_chart_line;
  const lastMs = Math.max(...byTime.keys(), 0);
  const dayOf = (id) => {
    let startMs = (id === 'today' ? periods.todayStart : periods.tomorrowStart).getTime();
    let endMs = (id === 'today' ? periods.tomorrowStart : periods.tomorrowEnd).getTime();
    if (id === 'next') { // from the current price slot to the last known price
      startMs = periods.periodStart.getTime();
      endMs = Math.max(startMs + slotMs, lastMs + slotMs);
    }
    const entries = Array.from({ length: Math.round((endMs - startMs) / slotMs) }, (_, i) => byTime.get(startMs + i * slotMs));
    return {
      startMs,
      entries,
      import: entries.map((e) => (e ? num(e.muPrice) : null)),
      export: showExport ? entries.map((e) => (e ? num(e.exportPrice) : null)) : null,
    };
  };
  // Lowest and highest price of each day, with 0: the widget keeps one scale for both days.
  const range = (x) => {
    const vals = x.import.concat(x.export || []).filter((v) => v !== null);
    return vals.length ? { lo: Math.min(0, ...vals), hi: Math.max(0, ...vals) } : null;
  };
  const days = { today: dayOf('today'), tomorrow: dayOf('tomorrow') };
  if (which === 'next') days.next = dayOf('next');
  const { startMs, entries } = days[which];
  const levels = PriceLevels.ofDevice(dev);
  return {
    price: true,
    day: which,
    name: dev.getName(),
    timeZone: dev.timeZone || homey.clock.getTimezone(),
    currency: settings.currency || '€',
    decimals: Number.isInteger(Number(settings.decimals)) ? Number(settings.decimals) : 4,
    startMs,
    slotMs,
    import: days[which].import,
    export: days[which].export,
    forecast: entries.map((e) => !!(e && e.isForecast)),
    level: entries.map((e) => ((levels.get(e ? new Date(e.time).getTime() : null) || {}).level || null)), // free, cheap, normal or dear
    levelAlpha: entries.map((e) => ((levels.get(e ? new Date(e.time).getTime() : null) || {}).alpha || 1)), // within lowest/highest
    range: { today: range(days.today), tomorrow: range(days.tomorrow) },
    canForecast: canForecast(dev),
    average: dev.priceProfile ? PriceProfile.average(dev.priceProfile) : null, // all known prices of up to 4 weeks
  };
};

// widgets/battery: one battery (the chosen one, else the first). Day tabs: what its charts show, per
// plan slot: price and export price, the action and its opacity (as the graph: ChargeChart.slotLook()),
// SoC (measured; planned ahead) and power (measured; planned ahead).
const BATTERY_DAYS = ['yesterday', 'today', 'tomorrow', 'next', 'weeks', 'year'];

// A period of widgets/battery: { charged, discharged, money (null unknown), est }: the sum of its days.
const sumBattery = (parts) => {
  const known = parts.filter((p) => p && typeof p.charged === 'number');
  if (!known.length) return null;
  const add = (f) => known.reduce((a, p) => a + p[f], 0);
  return {
    charged: add('charged'),
    discharged: add('discharged'),
    money: known.every((p) => typeof p.money === 'number') ? add('money') : null,
    est: known.some((p) => p.est),
  };
};

// Weeks: the last 28 days; year: per month (money of a past month exact from Insights when known).
const batteryBars = (dev, which, timeZone) => {
  const now = TimeHelpers.toLocalDate(new Date(), timeZone);
  const year = now.getFullYear();
  const today = {
    charged: capOf(dev, 'meter_kwh_this_day.charged'),
    discharged: capOf(dev, 'meter_kwh_this_day.discharged'),
    money: capOf(dev, 'meter_money_this_day'),
    est: false,
  };
  const day = (date) => {
    if (date.getTime() === Date.UTC(year, now.getMonth(), now.getDate())) return today.charged === null ? null : today;
    const y = date.getUTCFullYear();
    return BatteryDayLog.loggedDay(dev, y, BatteryDayLog.doyOf(y, date.getUTCMonth(), date.getUTCDate()));
  };
  const pad = (n) => String(n).padStart(2, '0');
  if (which === 'weeks') {
    return Array.from({ length: 28 }, (_, i) => {
      const date = new Date(Date.UTC(year, now.getMonth(), now.getDate() - 27 + i));
      return { ...(day(date) || {}), date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` };
    });
  }
  const log = dev.batteryDayLog && dev.batteryDayLog.year === year ? dev.batteryDayLog : null;
  return Array.from({ length: 12 }, (_, m) => {
    if (m > now.getMonth()) return null;
    const last = m === now.getMonth() ? now.getDate() : new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const sum = sumBattery(Array.from({ length: last }, (_, k) => day(new Date(Date.UTC(year, m, k + 1)))));
    if (!sum) return null;
    if (m === now.getMonth()) {
      const money = capOf(dev, 'meter_money_this_month');
      if (money !== null) sum.money = money;
    } else if (log && log.mMoney[m] !== -1) sum.money = log.mMoney[m];
    return sum;
  });
};
const getBattery = (homey, day, ids = []) => {
  const all = devicesOf(homey, 'battery');
  const dev = all.find((d) => ids.includes(d.getId())) || all[0];
  if (!dev) return { battery: null };
  const which = BATTERY_DAYS.includes(day) ? day : 'today';
  const priceDev = typeof dev._groupPriceDevices === 'function' ? dev._groupPriceDevices()[0] : null;
  const priceDecimals = priceDev && Number.isInteger(Number(priceDev.getSettings().decimals)) ? Number(priceDev.getSettings().decimals) : 4;
  const days = dev.chartDays || {};
  const out = {
    battery: true,
    day: which,
    name: dev.getName(),
    timeZone: dev.timeZone || homey.clock.getTimezone(),
    ...MoneyUnit.get(dev),
    priceDecimals,
    socNow: typeof dev.soc === 'number' ? dev.soc : null,
    powerNow: capOf(dev, 'measure_watt_avg'),
    money: { today: capOf(dev, 'meter_money_this_day'), yesterday: capOf(dev, 'meter_money_last_day') }[which] ?? null,
  };
  const range = (d) => {
    const vals = d ? d.slots.map((x) => x.price).concat(d.exportPrices).filter((v) => typeof v === 'number') : [];
    return vals.length ? { lo: Math.min(0, ...vals), hi: Math.max(0, ...vals) } : null;
  };
  out.range = { yesterday: range(days.yesterday), today: range(days.today), tomorrow: range(days.tomorrow) };
  // The next change of action from now on: { key, ms }.
  const { next } = days;
  if (next && next.slots.length) {
    const keys = next.slots.map((x, i) => slotLook(x, i, next).key);
    const i = keys.findIndex((k) => k !== keys[0] && k !== 'idle');
    out.nextAction = i > 0 ? { key: keys[i], ms: next.startMs + i * next.intervalMin * 60000 } : null;
    out.actionNow = keys[0];
  }
  if (which === 'weeks' || which === 'year') {
    const bars = batteryBars(dev, which, out.timeZone);
    return {
      ...out, bars, total: sumBattery(bars), building: BatteryDayLog.historyPending(dev),
    };
  }
  const d = days[which];
  if (!d) return { ...out, slots: null };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    ...out,
    startMs: d.startMs,
    slotMs: d.intervalMin * 60000,
    price: d.slots.map((x) => num(x.price)),
    exportPrice: d.slots.map((x, i) => num(d.exportPrices[i])),
    forecast: d.slots.map((x, i) => !!x.isForecast || i >= d.marketLength),
    action: d.slots.map((x, i) => slotLook(x, i, d).key),
    alpha: d.slots.map((x, i) => Math.round(slotLook(x, i, d).alpha * 100) / 100),
    soc: d.slots.map((x) => (x.isFuture ? null : num(x.soc))),
    socPlan: d.slots.map((x) => (x.isFuture ? num(x.soc) : null)),
    power: d.slots.map((x) => (x.isFuture ? num(x.power) : num(x.actualPower))),
  };
};

module.exports = {
  getBattery,
  getFlow,
  getPlan,
  getEnergy,
  getFlows,
  getSolar,
  getPrice,
  enableForecast,
  deviceZones,
  homeyZoneTotals,
  ownDeviceIds,
  sourceDeviceIds,
  allZoneIds,
};
