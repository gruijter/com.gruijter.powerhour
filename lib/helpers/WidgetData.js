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

// The live flows of widgets/power_flow. W, signed as on the Grid Monitor: grid + import,
// battery + charging, EV + charging.
const getFlow = (homey) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid) return { grid: null };
  const val = (cap) => Math.round(grid.getCapabilityValue(cap) || 0);
  const gridW = val('measure_watt_grid');
  const solarW = Math.max(0, val('measure_watt_solar'));
  const batteryW = val('measure_watt_battery');
  const evW = Math.max(0, val('measure_watt_evcharger'));
  const batteries = devicesOf(homey, 'battery');
  const evs = devicesOf(homey, 'evCharger');
  const report = grid.driver && grid.driver.lastEnergyReport;
  const hasSolar = devicesOf(homey, 'solar').length > 0
    || !!(report && report.totalGenerated && typeof report.totalGenerated.W === 'number');
  return {
    grid: gridW,
    solar: hasSolar ? solarW : null,
    battery: batteries.length ? batteryW : null,
    batterySoc: avg(batteries.map((d) => d.soc)),
    ev: evs.length ? evW : null,
    evSoc: evs.length === 1 ? avg(evs.map((d) => d.soc)) : null,
    // Unsmoothed balance, so the flows add up; timing skew can make it negative.
    home: Math.max(0, gridW + solarW - batteryW - evW),
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

  const price = Array.from({ length: n }, (_, i) => {
    const t = startMs + i * SLOT_MS;
    const e = prices && prices.list.find((p) => p.t <= t && t < p.t + prices.intervalMs);
    return e && typeof e.price === 'number' ? e.price : null;
  });
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

// kWh since the start of this period (hour/day/month/year) of widgets/energy. Import/export split
// and battery charged/discharged only with that data; gas in m³ (the widget converts).
const getEnergy = (homey, period) => {
  const grid = devicesOf(homey, 'grid')[0];
  if (!grid || typeof grid.getEnergySince !== 'function') return { grid: null };
  const p = PERIODS.includes(period) ? period : 'day';
  const sum = (driverId, cap) => {
    const devs = devicesOf(homey, driverId).filter((d) => d.hasCapability(cap));
    return devs.length ? devs.reduce((total, d) => total + (d.getCapabilityValue(cap) || 0), 0) : null;
  };
  const since = grid.getEnergySince(p);
  return {
    grid: true,
    period: p,
    net: grid.getCapabilityValue(`meter_kwh_this_${p}`) || 0,
    imported: since.imported,
    exported: since.exported,
    home: since.home,
    solar: sum('solar', `meter_kwh_this_${p}`),
    charged: devicesOf(homey, 'battery').length ? since.charged : null,
    discharged: devicesOf(homey, 'battery').length ? since.discharged : null,
    ev: sum('evCharger', `meter_kwh_this_${p}`),
    gasM3: sum('gas', `meter_m3_this_${p}`),
  };
};

module.exports = { getFlow, getPlan, getEnergy };
