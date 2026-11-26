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
const { ownDeviceIds } = require('./FlowScan');
const MoneyUnit = require('./MoneyUnit');
const ForecastSource = require('../strategies/ForecastSource');
const PriceLevels = require('./PriceLevels');
const PriceProfile = require('../strategies/PriceProfile');
const { slotLook } = require('../charts/ChargeChart');
const BatteryDayLog = require('./BatteryDayLog');
const { doyOf } = require('./DayLog');
const GridDayLog = require('./GridDayLog');
const FlowPairs = require('./FlowPairs');
const EvDayLog = require('./EvDayLog');
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

const climateDevices = (homey) => devicesOf(homey, 'power').filter((d) => d.getSettings().climate === true);

const sumCap = (devs, cap) => devs.reduce((total, d) => total + (d.getCapabilityValue(cap) || 0), 0);

const capOf = (d, cap) => (d.hasCapability(cap) && typeof d.getCapabilityValue(cap) === 'number' ? d.getCapabilityValue(cap) : null);

const evInfo = (d) => ({
  name: d.getName(),
  soc: capOf(d, 'measure_ev_soc'),
  state: d.hasCapability('ev_car_state') ? d.getCapabilityValue('ev_car_state') : null,
});

const mainMeters = (homey, driverId, grid) => {
  const devs = devicesOf(homey, driverId);
  const source = grid.getSettings().homey_device_id;
  const same = source ? devs.filter((d) => d.getSettings().homey_device_id === source) : [];
  return same.length ? same : devs;
};

const getFlow = (homey) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid) return { grid: null };
  const val = (cap) => Math.round(grid.getCapabilityValue(cap) || 0);
  const gridW = val('measure_watt_grid');
  const solarW = Math.max(0, val('measure_watt_solar'));
  const batteryW = val('measure_watt_battery');
  const evW = val('measure_watt_evcharger');
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
    gasLpm: gas.length ? sumCap(gas, 'measure_gas') : null,
    waterLpm: water.length ? sumCap(water, 'measure_water') : null,
    home: Math.max(0, gridW + solarW - batteryW - evW - (climateW || 0)),
  };
};

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

const plannedSlots = (dev, startMs, n, pick) => {
  const plan = dev.latestPlan;
  return Array.from({ length: n }, (_, i) => {
    if (!plan) return null;
    const idx = Math.floor((startMs + i * SLOT_MS - plan.startMs) / plan.intervalMs);
    const slot = idx >= 0 ? plan.slots[idx] : null;
    return slot ? pick(slot) : null;
  });
};
const plannedSoc = (dev, startMs, n) => plannedSlots(dev, startMs, n, (s) => (typeof s.soc === 'number' ? s.soc : null));
const SHOWN_BLOCKS = ['xom', 'hold'];
const plannedBlock = (devs, startMs, n) => {
  const lists = devs.map((d) => plannedSlots(d, startMs, n, (s) => s.block || null));
  return Array.from({ length: n }, (_, i) => SHOWN_BLOCKS.find((b) => lists.some((l) => l[i] === b)) || null);
};

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
  const socEvs = evs.filter((d) => !(typeof d._energyMode === 'function' && d._energyMode()));
  const evSocs = socEvs.map((d) => plannedSoc(d, futureStart, n - past));
  const socOf = (devs, plans) => series(
    (t) => avg(devs.map((d) => (typeof d.getActualSocForTime === 'function' ? d.getActualSocForTime(t) : null))),
    Array.from({ length: n - past }, (_, i) => avg(plans.map((s) => s[i]))),
  );
  const appliances = typeof grid.getApplianceDevices === 'function' ? grid.getApplianceDevices() : [];
  const actual = (d, t) => (typeof d.getActualPowerForTime === 'function' ? d.getActualPowerForTime(t) : null);
  const maxOf = (devs) => {
    const days = devs.map((d) => (d.chartDays && d.chartDays.today) || {});
    return {
      charge: days.reduce((a, x) => a + (Number(x.maxChargePower) || 0), 0),
      discharge: days.reduce((a, x) => a + (Number(x.maxDischargePower) || 0), 0),
    };
  };

  return {
    grid: true,
    day: which,
    timeZone: tz,
    startMs,
    slotMs: SLOT_MS,
    past,
    currency: prices ? prices.currency : null,
    price: prices ? price : null,
    priceForecast: entries.map((e) => !!(e && e.forecast)),
    priceLevel: entries.map((e) => (e && prices.levels.has(e.t) ? prices.levels.get(e.t).level : null)),
    priceAlpha: entries.map((e) => (e && prices.levels.has(e.t) ? prices.levels.get(e.t).alpha : 1)),
    solar: solars.length ? series(sumOf(solars, (d, t) => mean(d.powerHistory, t, 'power')), f && f.solar) : null,
    home: series((t) => mean(grid.powerHistory, t, 'power'), f && f.load),
    battery: batteries.length ? series(sumOf(batteries, actual), f && f.battery) : null,
    soc: batteries.length ? socOf(batteries, socs) : null,
    batteryBlock: batteries.length ? series(() => null, plannedBlock(batteries, futureStart, n - past)) : null,
    batteryMax: maxOf(batteries),
    ev: evs.length ? series(sumOf(evs, actual), f && f.ev) : null,
    evSoc: socEvs.length ? socOf(socEvs, evSocs) : null,
    evMax: maxOf(evs),
    appliances: appliances.map((d) => {
      const slots = new Map((d.applianceSlots || []).map((e) => [e.t, Math.round(e.kwh * 4000)]));
      const ahead = past < n ? (d.getForecastSeries(futureStart, endMs) || []) : [];
      return { name: d.getName(), w: series((t) => slots.get(t) || 0, ahead).map((v) => Math.round(v || 0)) };
    }),
    net: series((t) => mean(grid.powerHistory, t, 'grid'), f && f.netPlanned),
  };
};

const PERIODS = ['hour', 'day', 'month', 'year'];

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
    home: typeof capOf(grid, `meter_kwh_this_${p}.home`) === 'number' ? Math.max(0, capOf(grid, `meter_kwh_this_${p}.home`) - (climateKwh || 0)) : null,
    climate: climateKwh,
    solar: sum('solar', `meter_kwh_this_${p}`),
    charged: sumOf(batteries, `meter_kwh_this_${p}.charged`),
    discharged: sumOf(batteries, `meter_kwh_this_${p}.discharged`),
    ev: sum('evCharger', `meter_kwh_this_${p}`),
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
      solar: negate(sum('solar', money)),
      battery: negate(sum('battery', money)),
      ev: sum('evCharger', money),
      gas: sumOf(gas, money),
      water: sumOf(water, money),
      climate: climate.length ? sumCap(climate, money) : null,
    },
  };
};

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

const userIds = (d) => ({ id: d.getId(), sourceId: d.getSettings().homey_device_id || null });

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
  const taken = sourceDeviceIds(homey, new Set());
  const chosen = devicesOf(homey, 'power')
    .filter((d) => d.getSettings().climate !== true && !taken.has(d.getSettings().homey_device_id))
    .filter((d) => (ids.length ? rank(d) >= 0 : !d.getSettings().homey_energy))
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
    out.pairs = FlowPairs.period(grid, p);
  }
  out.sources = out.sources.filter((src) => src.key !== 'ev' || src.value > 0);
  return out;
};

const ZONE_TTL = 10 * 60 * 1000;
let zoneCache = { tm: 0, zones: {}, devices: {} };

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

const allZoneIds = async (homey) => {
  await deviceZones(homey, ['-']);
  return Object.keys(zoneCache.zones);
};

const localParts = (homey) => {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: homey.clock.getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).forEach((x) => {
    parts[x.type] = x.value;
  });
  return parts;
};

const zoneTotalCache = {};
const homeyZoneTotals = async (homey, period, zoneIds, skipIds = new Set()) => {
  const api = homey.app && homey.app.api;
  if (!api || !api.energy || !zoneIds.length || period === 'hour') return null;
  const key = `${period}:${zoneIds.slice().sort().join(',')}:${[...skipIds].sort().join(',')}`;
  const ttl = period === 'now' ? 30000 : 60000;
  const hit = zoneTotalCache[key];
  if (hit && Date.now() - hit.tm < ttl) return hit.result;
  const own = ownDeviceIds(homey);
  skipIds.forEach((id) => own.add(id));
  const totals = {};
  const devices = {};
  if (period === 'now') {
    for (const zone of zoneIds) {
      // eslint-disable-next-line no-await-in-loop
      const report = await api.energy.getLiveReport({ zone }).catch(() => null);
      if (!report) continue;
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

const localKey = (ms, timeZone) => new Date(ms).toLocaleDateString('en-CA', { timeZone });

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

const todayOf = (d) => {
  const kwh = capOf(d, 'meter_kwh_this_day');
  const pct = capOf(d, 'measure_solar_use.this_day');
  return typeof kwh === 'number' ? {
    kwh, own: typeof pct === 'number' ? (kwh * pct) / 100 : null, money: capOf(d, 'meter_money_this_day'), est: false,
  } : null;
};

const solarDay = (devs, key, todayKey) => {
  if (key === todayKey) return sumPeriods(devs.map(todayOf));
  const [y, m, d] = key.split('-').map(Number);
  return sumPeriods(devs.map((dev) => (typeof dev.loggedDay === 'function' ? dev.loggedDay(y, doyOf(y, m - 1, d)) : null)));
};

const solarMonth = (devs, year, m, lastDay, todayKey) => {
  const pad = (n) => String(n).padStart(2, '0');
  const perDevice = devs.map((dev) => {
    const days = [];
    for (let day = 1; day <= lastDay; day += 1) days.push(solarDay([dev], `${year}-${pad(m + 1)}-${pad(day)}`, todayKey));
    const sum = sumPeriods(days);
    if (!sum) return null;
    if (days.some((x) => !x || typeof x.kwh !== 'number')) sum.est = true;
    const scaled = sumPeriods(days, true);
    const log = dev.dayLog && dev.dayLog.v === 2 && dev.dayLog.year === year ? dev.dayLog : null;
    if (sum.own === null && log && log.mShare[m] >= 0) sum.own = sum.kwh * log.mShare[m];
    if (sum.money === null && log && log.mValue[m] >= 0) sum.money = sum.kwh * log.mValue[m];
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

const solarScale = (dev, which) => {
  const shown = dev.chartScalesShown && dev.chartScalesShown[which];
  if (typeof shown === 'number') return shown;
  return typeof dev.chartScales === 'function' ? dev.chartScales()[which] : dev.chartPeak();
};

const getSolar = (homey, day, ids = []) => {
  const present = devicesOf(homey, 'solar');
  const all = present.filter((d) => typeof d.solarDay === 'function' && d.forecastHistory);
  const chosen = all.filter((d) => ids.includes(d.getId()));
  const devs = chosen.length ? chosen : all;
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
  if (which === 'yesterday') {
    const yesterday = new Date(Date.UTC(year, month - 1, dayNr - 1));
    total = solarDay(devs, `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth() + 1)}-${pad(yesterday.getUTCDate())}`, todayKey);
  }
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
  const grid = devicesOf(homey, 'grid')[0];
  const gridHistory = grid && Array.isArray(grid.powerHistory) ? grid.powerHistory : null;
  const allSeries = devs.length === all.length ? series : all.map((d) => d.solarDay(which, range)).filter(Boolean);
  const own = which === 'tomorrow' || !gridHistory ? null : series[0].times.slice(0, n).map((t, i) => {
    if (!(real[i] > 0)) return null;
    const total = allSeries.reduce((a, x) => a + (typeof x.real[i] === 'number' ? x.real[i] : 0), 0);
    const g = findClosestSample(gridHistory, t, 10 * 60 * 1000, 'grid');
    return typeof g === 'number' && total > 0 ? Math.round(Math.min(1, Math.max(0, 1 - Math.max(0, -g) / total)) * 1000) / 1000 : null;
  });
  return {
    ...out,
    total,
    startMs: series[0].times[0],
    slotMs: SLOT_MS,
    forecast,
    real,
    own,
    peak: devs.reduce((a, d) => a + (solarScale(d, which) || 0), 0),
    expectedKwh: forecast.reduce((a, v) => a + v, 0) / 4000,
    nowW: which === 'today' ? sumCap(devs.filter((d) => typeof capOf(d, 'measure_power') === 'number'), 'measure_power') : null,
  };
};

const PRICE_DAYS = ['today', 'tomorrow', 'next'];
const priceDevice = (homey, ids) => {
  const all = PriceDrivers.getDevices(homey);
  const grid = devicesOf(homey, 'grid')[0];
  const group = grid ? grid.getSettings().tariff_update_group : null;
  const power = all.filter((d) => d.hasExport).sort((a, b) => (a.driver.id === 'price' ? 0 : 1) - (b.driver.id === 'price' ? 0 : 1));
  return all.find((d) => ids.includes(d.getId()))
    || power.find((d) => d.getSettings().tariff_update_group === group) || power[0] || all[0];
};

const canForecast = (dev) => {
  const settings = dev.getSettings();
  if (dev.driver.id !== 'price' || !dev.hasExport || settings.forecastEnable || settings.tariffType === 'fixed') return false;
  return new ForecastSource({
    choice: settings.forecastProvider, apiKey: settings.energyForecastApiKey, biddingZone: settings.biddingZone,
  }).available;
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
    if (id === 'next') {
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
    level: entries.map((e) => ((levels.get(e ? new Date(e.time).getTime() : null) || {}).level || null)),
    levelAlpha: entries.map((e) => ((levels.get(e ? new Date(e.time).getTime() : null) || {}).alpha || 1)),
    range: { today: range(days.today), tomorrow: range(days.tomorrow) },
    canForecast: canForecast(dev),
    average: dev.priceProfile ? PriceProfile.average(dev.priceProfile) : null,
  };
};

const CHARGE_DAYS = ['yesterday', 'today', 'tomorrow', 'next', 'weeks', 'year'];
const CHARGE_KINDS = {
  battery: {
    driver: 'battery',
    log: BatteryDayLog,
    today: (dev) => ({ charged: capOf(dev, 'meter_kwh_this_day.charged'), discharged: capOf(dev, 'meter_kwh_this_day.discharged') }),
    soc: (dev) => (typeof dev.soc === 'number' ? dev.soc : null),
    discharges: () => true,
  },
  ev: {
    driver: 'evCharger',
    log: EvDayLog,
    today: (dev) => ({
      charged: capOf(dev, 'meter_kwh_this_day.charged') ?? capOf(dev, 'meter_kwh_this_day'),
      discharged: capOf(dev, 'meter_kwh_this_day.discharged') ?? 0,
    }),
    soc: (dev) => capOf(dev, 'measure_ev_soc'),
    discharges: (dev) => !!dev.getSettings().v2x,
  },
};

const sumDays = ([a, b]) => (parts) => {
  const known = parts.filter((x) => x && typeof x[a] === 'number');
  if (!known.length) return null;
  const add = (f) => known.reduce((sum, x) => sum + x[f], 0);
  return {
    [a]: add(a),
    [b]: add(b),
    money: known.every((x) => typeof x.money === 'number') ? add('money') : null,
    est: known.some((x) => x.est),
  };
};

const logBars = (dev, log, fields, today, which, timeZone) => {
  const [a] = fields;
  const sum = sumDays(fields);
  const now = TimeHelpers.toLocalDate(new Date(), timeZone);
  const year = now.getFullYear();
  const day = (date) => {
    if (date.getTime() === Date.UTC(year, now.getMonth(), now.getDate())) return today[a] === null ? null : today;
    const y = date.getUTCFullYear();
    return log.loggedDay(dev, y, log.doyOf(y, date.getUTCMonth(), date.getUTCDate()));
  };
  const pad = (n) => String(n).padStart(2, '0');
  if (which === 'weeks') {
    return Array.from({ length: 28 }, (_, i) => {
      const date = new Date(Date.UTC(year, now.getMonth(), now.getDate() - 27 + i));
      return { ...(day(date) || {}), date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` };
    });
  }
  return Array.from({ length: 12 }, (_, m) => {
    if (m > now.getMonth()) return null;
    const last = m === now.getMonth() ? now.getDate() : new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const days = Array.from({ length: last }, (_, k) => day(new Date(Date.UTC(year, m, k + 1))));
    const total = sum(days);
    if (!total) return null;
    total.est = days.some((x) => !x || typeof x[a] !== 'number');
    const money = m === now.getMonth() ? capOf(dev, 'meter_money_this_month') : log.monthMoney(dev, year, m);
    if (money !== null) total.money = money;
    return total;
  });
};

const CHARGE_FIELDS = ['charged', 'discharged'];
const sumBattery = sumDays(CHARGE_FIELDS);
const chargeBars = (kind, dev, which, timeZone) => logBars(dev, CHARGE_KINDS[kind].log, CHARGE_FIELDS,
  { ...CHARGE_KINDS[kind].today(dev), money: capOf(dev, 'meter_money_this_day'), est: false }, which, timeZone);
const look = (slot, i, d) => slotLook(slot, i, { ...d, interval: d.intervalMin });

const getCharge = (kind, homey, day, ids = []) => {
  const spec = CHARGE_KINDS[kind];
  const all = devicesOf(homey, spec.driver);
  const dev = all.find((d) => ids.includes(d.getId())) || all[0];
  if (!dev) return { [kind]: null };
  const which = CHARGE_DAYS.includes(day) ? day : 'today';
  const priceDev = typeof dev._groupPriceDevices === 'function' ? dev._groupPriceDevices()[0] : null;
  const priceDecimals = priceDev && Number.isInteger(Number(priceDev.getSettings().decimals)) ? Number(priceDev.getSettings().decimals) : 4;
  const days = dev.chartDays || {};
  const out = {
    [kind]: true,
    day: which,
    name: dev.getName(),
    discharges: spec.discharges(dev),
    timeZone: dev.timeZone || homey.clock.getTimezone(),
    ...MoneyUnit.get(dev),
    priceDecimals,
    socNow: spec.soc(dev),
    powerNow: capOf(dev, 'measure_watt_avg'),
    money: { today: capOf(dev, 'meter_money_this_day'), yesterday: capOf(dev, 'meter_money_last_day') }[which] ?? null,
  };
  const range = (d) => {
    const vals = d ? d.slots.map((x) => x.price).concat(d.exportPrices).filter((v) => typeof v === 'number') : [];
    return vals.length ? { lo: Math.min(0, ...vals), hi: Math.max(0, ...vals) } : null;
  };
  out.range = { yesterday: range(days.yesterday), today: range(days.today), tomorrow: range(days.tomorrow) };
  const { next } = days;
  if (next && next.slots.length) {
    const keys = next.slots.map((x, i) => look(x, i, next).key);
    const i = keys.findIndex((k) => k !== keys[0] && k !== 'idle');
    out.nextAction = i > 0 ? { key: keys[i], ms: next.startMs + i * next.intervalMin * 60000 } : null;
    out.actionNow = keys[0];
  }
  if (which === 'weeks' || which === 'year') {
    const bars = chargeBars(kind, dev, which, out.timeZone);
    return {
      ...out, bars, total: sumBattery(bars), building: spec.log.historyPending(dev),
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
    action: d.slots.map((x, i) => look(x, i, d).key),
    alpha: d.slots.map((x, i) => Math.round(look(x, i, d).alpha * 100) / 100),
    soc: d.slots.map((x) => (x.isFuture ? null : num(x.soc))),
    socPlan: d.slots.map((x) => (x.isFuture ? num(x.soc) : null)),
    power: d.slots.map((x) => (x.isFuture ? num(x.power) : num(x.actualPower))),
  };
};

const GRID_DAYS = ['yesterday', 'today', 'tomorrow', 'weeks', 'year'];
const GRID_FIELDS = ['imported', 'exported'];
const sumGrid = sumDays(GRID_FIELDS);
const gridBars = (dev, which, timeZone) => logBars(dev, GridDayLog, GRID_FIELDS, {
  imported: capOf(dev, 'meter_kwh_this_day.imported'),
  exported: capOf(dev, 'meter_kwh_this_day.exported') ?? 0,
  money: capOf(dev, 'meter_money_this_day'),
  est: false,
}, which, timeZone);
const GRID_SCALE_DAYS = ['yesterday', 'today', 'tomorrow'];
const SCALE_SHARE = 0.5;

const gridDay = (dev, which, timeZone) => {
  const today = TimeHelpers.getLocalMidnightUTC(new Date(), timeZone).getTime();
  const midnightAfter = (ms) => TimeHelpers.getLocalMidnightUTC(new Date(ms + 26 * 3600000), timeZone).getTime();
  const startMs = { yesterday: TimeHelpers.getLocalMidnightUTC(new Date(today - 3600000), timeZone).getTime(), today, tomorrow: midnightAfter(today) }[which];
  const endMs = midnightAfter(startMs);
  const n = Math.round((endMs - startMs) / SLOT_MS);
  const nowSlot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  const planned = endMs > nowSlot ? dev.getNetForecast(startMs, endMs).netPlanned : [];
  const recorded = new Map((dev.netForecastHistory || []).map((e) => [e.time, e.net]));
  const history = dev.powerHistory.filter((e) => e.time >= startMs - SLOT_MS && e.time <= endMs + SLOT_MS);
  const forecast = [];
  const real = [];
  for (let i = 0; i < n; i += 1) {
    const t = startMs + i * SLOT_MS;
    const f = t >= nowSlot ? planned[i] : recorded.get(t);
    forecast.push(typeof f === 'number' ? Math.round(f) : null);
    real.push(t <= Date.now() ? findClosestSample(history, t, 10 * 60 * 1000, 'grid') : null);
  }
  return { startMs, forecast, real };
};

const daySpan = (d) => {
  const nums = d.forecast.concat(d.real).filter((v) => typeof v === 'number');
  return { lo: Math.min(0, ...nums), hi: Math.max(0, ...nums) };
};

const gridSpans = (dev, which, shown, timeZone) => {
  const slot = Math.floor(Date.now() / SLOT_MS);
  if (!dev.gridSpanCache || dev.gridSpanCache.slot !== slot) dev.gridSpanCache = { slot, spans: {} };
  const { spans } = dev.gridSpanCache;
  spans[which] = daySpan(shown);
  GRID_SCALE_DAYS.forEach((d) => {
    if (!spans[d]) spans[d] = daySpan(gridDay(dev, d, timeZone));
  });
  return spans;
};

const sharedScale = (spans, which) => {
  const all = { lo: Math.min(...Object.values(spans).map((x) => x.lo)), hi: Math.max(...Object.values(spans).map((x) => x.hi)) };
  const own = spans[which];
  return own.hi - own.lo >= SCALE_SHARE * (all.hi - all.lo) ? all : own;
};

const getGrid = (homey, day) => {
  const dev = devicesOf(homey, 'grid')[0];
  if (!dev) return { grid: null };
  if (typeof dev.getNetForecast !== 'function' || !Array.isArray(dev.powerHistory)) return { grid: false };
  const which = GRID_DAYS.includes(day) ? day : 'today';
  const timeZone = dev.timeZone || homey.clock.getTimezone();
  const out = {
    grid: true,
    day: which,
    timeZone,
    ...MoneyUnit.get(dev),
    building: GridDayLog.historyPending(dev),
    nowW: capOf(dev, 'measure_watt_grid'),
  };
  if (which === 'weeks' || which === 'year') {
    const bars = gridBars(dev, which, timeZone);
    return { ...out, bars, total: sumGrid(bars) };
  }
  const shown = gridDay(dev, which, timeZone);
  const { startMs, forecast, real } = shown;
  const expected = (sign) => forecast.reduce((a, v) => a + (typeof v === 'number' ? Math.max(0, sign * v) : 0), 0) / 4000;
  const total = {
    today: {
      imported: capOf(dev, 'meter_kwh_this_day.imported'), exported: capOf(dev, 'meter_kwh_this_day.exported'), money: capOf(dev, 'meter_money_this_day'), est: false,
    },
    yesterday: {
      imported: capOf(dev, 'meter_kwh_last_day.imported'), exported: capOf(dev, 'meter_kwh_last_day.exported'), money: capOf(dev, 'meter_money_last_day'), est: false,
    },
    tomorrow: {
      imported: expected(1), exported: expected(-1), money: null, est: true,
    },
  }[which];
  return {
    ...out,
    total,
    expected: { imported: expected(1), exported: expected(-1) },
    startMs,
    slotMs: SLOT_MS,
    forecast,
    real,
    scale: sharedScale(gridSpans(dev, which, shown, timeZone), which),
  };
};

const getBattery = (homey, day, ids) => getCharge('battery', homey, day, ids);
const getEv = (homey, day, ids) => getCharge('ev', homey, day, ids);

module.exports = {
  getBattery,
  getEv,
  getFlow,
  getPlan,
  getEnergy,
  getFlows,
  getSolar,
  getGrid,
  getPrice,
  enableForecast,
  deviceZones,
  homeyZoneTotals,
  ownDeviceIds,
  sourceDeviceIds,
  allZoneIds,
};
