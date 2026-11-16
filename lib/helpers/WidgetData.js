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
  if (!grid || typeof grid.getEnergySince !== 'function') return { grid: null };
  const p = PERIODS.includes(period) ? period : 'day';
  const sumOf = (all, cap) => {
    const devs = all.filter((d) => d.hasCapability(cap));
    return devs.length ? sumCap(devs, cap) : null;
  };
  const sum = (driverId, cap) => sumOf(devicesOf(homey, driverId), cap);
  const gas = mainMeters(homey, 'gas', grid);
  const water = mainMeters(homey, 'water', grid);
  const since = grid.getEnergySince(p);
  const climate = climateDevices(homey);
  const climateKwh = climate.length ? sumCap(climate, `meter_kwh_this_${p}`) : null;
  const money = `meter_money_this_${p}`;
  return {
    grid: true,
    period: p,
    net: grid.getCapabilityValue(`meter_kwh_this_${p}`) || 0,
    imported: since.imported,
    exported: since.exported,
    // The home without climate; the climate meters can run ahead of the home counter.
    home: typeof since.home === 'number' ? Math.max(0, since.home - (climateKwh || 0)) : null,
    climate: climateKwh,
    solar: sum('solar', `meter_kwh_this_${p}`),
    charged: devicesOf(homey, 'battery').length ? since.charged : null,
    discharged: devicesOf(homey, 'battery').length ? since.discharged : null,
    ev: sum('evCharger', `meter_kwh_this_${p}`),
    // Per EV; charged and discharged apart only with V2X, like the battery.
    evs: devicesOf(homey, 'evCharger').map((d) => {
      const v2x = typeof since[`ev_${d.getId()}_discharged`] === 'number';
      return {
        ...evInfo(d),
        kwh: capOf(d, `meter_kwh_this_${p}`),
        money: capOf(d, money),
        charged: v2x ? since[`ev_${d.getId()}_charged`] : null,
        discharged: v2x ? since[`ev_${d.getId()}_discharged`] : null,
      };
    }),
    gasM3: sumOf(gas, `meter_m3_this_${p}`),
    waterM3: sumOf(water, `meter_m3_this_${p}`),
    money: {
      ...MoneyUnit.get(grid),
      grid: grid.hasCapability(money) ? grid.getCapabilityValue(money) || 0 : null,
      solar: sum('solar', money),
      battery: sum('battery', money),
      ev: sum('evCharger', money),
      gas: sumOf(gas, money),
      water: sumOf(water, money),
      climate: climate.length ? sumCap(climate, money) : null,
    },
  };
};

// widgets/flows: the flows of widgets/energy as a Sankey diagram, with more single users. W (period
// now) or kWh since the start of the period; gas in L/min or m³ (the widget converts with its kWh per
// m³). Sources: grid import, solar, battery and EV (V2X) discharging. Destinations: export, battery
// charging, each EV, each climate summarizer and the home without those (home); users: the devices
// chosen in the widget (ids, Homey device ids in that order), Power Summarizers without climate role.
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
  const chosen = devicesOf(homey, 'power')
    .filter((d) => d.getSettings().climate !== true && rank(d) >= 0)
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
    out.users = chosen.map((d) => ({ name: d.getName(), value: pos(w(d)) }));
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
    out.users = chosen.map((d) => ({ name: d.getName(), value: kwh(d) }));
    out.gas = e.gasM3;
  }
  out.sources = out.sources.filter((src) => src.key !== 'ev' || src.value > 0);
  return out;
};

module.exports = {
  getFlow, getPlan, getEnergy, getFlows,
};
