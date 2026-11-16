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
// (12-36 h). W as getNetForecast(): battery + charge, net + import.
const getPlan = (homey) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid || typeof grid.getNetForecast !== 'function') return { grid: null };
  const startMs = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  const prices = groupPrices(homey, grid);
  const priceEnd = prices && prices.list.length
    ? prices.list[prices.list.length - 1].t + prices.intervalMs : startMs + 24 * 60 * 60 * 1000;
  const endMs = startMs + Math.min(PLAN_MAX_MS, Math.max(PLAN_MIN_MS, Math.ceil((priceEnd - startMs) / SLOT_MS) * SLOT_MS));
  const n = Math.round((endMs - startMs) / SLOT_MS);
  const f = grid.getNetForecast(startMs, endMs);

  const entries = Array.from({ length: n }, (_, i) => {
    const t = startMs + i * SLOT_MS;
    return prices && prices.list.find((p) => p.t <= t && t < p.t + prices.intervalMs);
  });
  const price = entries.map((e) => (e && typeof e.price === 'number' ? e.price : null));
  const batteries = devicesOf(homey, 'battery');
  const socs = batteries.map((d) => plannedSoc(d, startMs, n));
  const evs = devicesOf(homey, 'evCharger');
  // A car without SoC (energy mode) has no SoC plan.
  const evSocs = evs.filter((d) => !(typeof d._energyMode === 'function' && d._energyMode())).map((d) => plannedSoc(d, startMs, n));
  const appliances = typeof grid.getApplianceDevices === 'function' ? grid.getApplianceDevices() : [];

  return {
    grid: true,
    timeZone: grid.timeZone || homey.clock.getTimezone(),
    startMs,
    slotMs: SLOT_MS,
    currency: prices ? prices.currency : null,
    price: price.some((p) => p !== null) ? price : null,
    priceForecast: entries.map((e) => !!(e && e.forecast)), // expected, not yet known prices
    solar: devicesOf(homey, 'solar').length ? f.solar : null,
    home: f.load,
    battery: batteries.length ? f.battery : null,
    soc: batteries.length ? Array.from({ length: n }, (_, i) => avg(socs.map((s) => s[i]))) : null,
    ev: evs.length ? f.ev : null,
    evSoc: evSocs.length ? Array.from({ length: n }, (_, i) => avg(evSocs.map((e) => e[i]))) : null,
    appliances: appliances.map((d) => ({ name: d.getName(), w: (d.getForecastSeries(startMs, endMs) || []).map((v) => Math.round(v || 0)) }))
      .filter((a) => a.w.some((v) => v > 0)),
    net: f.netPlanned,
  };
};

const PERIODS = ['hour', 'day', 'month', 'year'];

// kWh and money since the start of this period (hour/day/month/year) of widgets/energy. Import/export
// split and battery charged/discharged only with that data; gas and water in m³ (the widget converts
// gas). Money as the meters keep it: grid, EV, gas, water and climate costs; solar value; battery
// profit.
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
      solar: sum('solar', money),
      // Battery money is profit: negative here, like the grid (+ = paid).
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

module.exports = {
  getFlow, getPlan, getEnergy, getFlows, deviceZones, homeyZoneTotals, ownDeviceIds, sourceDeviceIds, allZoneIds,
};
