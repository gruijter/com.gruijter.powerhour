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

// Monthly budget distribution (12 shares) for the local climate; the climate summary comes from
// lib/helpers/ClimateNormals.js. Parts fitted on ERA5 De Bilt 2014-2023 against the NEDU profiles
// E1A and G1A, kept at their Dutch size per degree-day or night hour. Heat pump COP: EN 14511
// ratings; air conditioning: EIA RECS 2020.

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HEAT_BASE = 12.5; // °C, heating degree-days for space heating
const HOUSE_BASE = 13.5; // °C, heating degree-days in household electricity
const COOL_BASE = 18; // °C
const HYBRID_SWITCH = 3; // °C daily mean: below it a hybrid heat pump leaves heating to the boiler
const DHW_COP = 2.5; // heat pump for hot water (higher water temperature)

// De Bilt 2014-2023 (ERA5): yearly sums the fitted weights refer to.
const REF = {
  hdd: 1196.2, // heating degree-days base 12.5
  hddHouse: 1413.4, // base 13.5
  night: 4304.9, // night hours at 52.1°N
  hpKwhUnits: 0.3042, // heat pump use in heat units (see heatPumpUnits)
};
const HP_RATIO = 1.6;
const AC_RATIO = (cdd) => 0.225 + (0.186 * cdd) / 1000;

const cop = (t) => Math.min(5, Math.max(2.3, 3.5 + 0.1 * (t - 2)));

/**
 * Monthly sums from daily mean temperatures, per year.
 * @param {string[]} dates - 'YYYY-MM-DD'
 * @param {number[]} temps - daily mean (°C)
 */
const summarize = (dates, temps) => {
  const z = () => new Array(12).fill(0);
  const s = {
    hdd: z(), hddHouse: z(), hddCop: z(), hddWarm: z(), hddWarmCop: z(), cdd: z(), tSum: z(), n: z(),
  };
  const years = new Set();
  dates.forEach((date, i) => {
    const t = temps[i];
    if (typeof t !== 'number' || date.slice(5, 10) === '02-29') return;
    years.add(date.slice(0, 4));
    const m = Number(date.slice(5, 7)) - 1;
    const hdd = Math.max(0, HEAT_BASE - t);
    s.hdd[m] += hdd;
    s.hddHouse[m] += Math.max(0, HOUSE_BASE - t);
    s.hddCop[m] += hdd / cop(t);
    if (t >= HYBRID_SWITCH) {
      s.hddWarm[m] += hdd;
      s.hddWarmCop[m] += hdd / cop(t);
    }
    s.cdd[m] += Math.max(0, t - COOL_BASE);
    s.tSum[m] += t;
    s.n[m] += 1;
  });
  const y = years.size || 1;
  const out = {};
  ['hdd', 'hddHouse', 'hddCop', 'hddWarm', 'hddWarmCop', 'cdd'].forEach((k) => {
    out[k] = s[k].map((v) => Math.round((v / y) * 10) / 10);
  });
  out.tMean = s.tSum.map((v, m) => (s.n[m] ? Math.round((v / s.n[m]) * 10) / 10 : null));
  out.years = years.size;
  return out;
};

/**
 * Night hours per month (standard day length, sunrise at -0.83°).
 * @param {number} lat
 */
const nightHours = (lat) => {
  const out = new Array(12).fill(0);
  const phi = (lat * Math.PI) / 180;
  const h0 = (-0.83 * Math.PI) / 180;
  let doy = 0;
  DAYS.forEach((n, m) => {
    for (let d = 0; d < n; d += 1) {
      doy += 1;
      const dec = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + doy)) / 365);
      const c = Math.max(-1, Math.min(1, (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))));
      out[m] += 24 - (2 * ((Math.acos(c) * 180) / Math.PI)) / 15;
    }
  });
  return out;
};

const normalize = (arr) => {
  const sum = arr.reduce((a, v) => a + v, 0);
  return sum > 0 ? arr.map((v) => v / sum) : null;
};

// Parts in "Dutch household year" units: a part sums to its fitted share in De Bilt.
const parts = (climate, lat) => {
  const night = nightHours(lat);
  return {
    house: climate.hdd.map((_, m) => 0.14 * (DAYS[m] / 365) + (0.10 * climate.hddHouse[m]) / REF.hddHouse + (0.76 * night[m]) / REF.night),
    spaceHeat: climate.hdd.map((v) => (0.73 * v) / REF.hdd),
    spaceHeatCop: climate.hddCop.map((v) => (0.73 * v) / REF.hdd),
    warmHeatCop: climate.hddWarmCop.map((v) => (0.73 * v) / REF.hdd),
    coldHeat: climate.hdd.map((v, m) => (0.73 * (v - climate.hddWarm[m])) / REF.hdd),
    hotWater: night.map((v) => (0.27 * v) / REF.night),
  };
};

// Heat pump electricity of the parts (space heating / COP, hot water / DHW_COP), in heat units.
const heatPumpUnits = (p) => p.spaceHeatCop.map((v, m) => v + p.hotWater[m] / DHW_COP);

/**
 * 12 monthly shares (sum 1), or null without a usable climate.
 * @param {object} o
 * @param {'electricity'|'gas'} o.kind
 * @param {object} o.climate - summarize()
 * @param {number} o.lat
 * @param {string} [o.heating] - electricity: 'none' | 'heat_pump' | 'hybrid' | 'electric';
 *   gas: 'boiler' | 'hybrid' | 'none' (cooking and hot water only)
 * @param {boolean} [o.cooling] - electricity: air conditioning
 */
const profile = ({
  kind, climate, lat, heating, cooling = false,
}) => {
  if (!climate || !Array.isArray(climate.hdd) || climate.hdd.length !== 12 || !Number.isFinite(lat)) return null;
  const p = parts(climate, lat);
  if (kind === 'gas') {
    if (heating === 'none') return normalize(p.hotWater);
    if (heating === 'hybrid') return normalize(p.coldHeat.map((v, m) => v + p.hotWater[m]));
    return normalize(p.spaceHeat.map((v, m) => v + p.hotWater[m]));
  }
  // Electricity: kWh relative to the household use in the Dutch climate.
  const scale = HP_RATIO / REF.hpKwhUnits;
  const total = p.house.slice();
  const add = (arr) => arr.forEach((v, m) => {
    total[m] += v;
  });
  if (heating === 'heat_pump') add(heatPumpUnits(p).map((v) => v * scale));
  if (heating === 'hybrid') add(p.warmHeatCop.map((v) => v * scale)); // hot water from the boiler
  if (heating === 'electric') add(p.spaceHeat.map((v, m) => (v + p.hotWater[m]) * scale));
  if (cooling) {
    const cddYear = climate.cdd.reduce((a, v) => a + v, 0);
    const houseYear = p.house.reduce((a, v) => a + v, 0);
    const cool = normalize(climate.cdd);
    if (cool) add(cool.map((v) => v * AC_RATIO(cddYear) * houseYear));
  }
  return normalize(total);
};

/**
 * 12 monthly shares from monthly PV yields (PVGIS E_m), or null.
 * @param {number[]} monthlyKwh
 */
const pvProfile = (monthlyKwh) => (Array.isArray(monthlyKwh) && monthlyKwh.length === 12
  && monthlyKwh.every((v) => Number.isFinite(v) && v >= 0) ? normalize(monthlyKwh) : null);

module.exports = {
  summarize,
  nightHours,
  profile,
  pvProfile,
  cop,
  REF,
  _parts: parts,
  _heatPumpUnits: heatPumpUnits,
};
