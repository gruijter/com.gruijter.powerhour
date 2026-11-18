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

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HEAT_BASE = 12.5;
const HOUSE_BASE = 13.5;
const COOL_BASE = 18;
const HYBRID_SWITCH = 3;
const DHW_COP = 2.5;

const REF = {
  hdd: 1196.2,
  hddHouse: 1413.4,
  night: 4304.9,
  hpKwhUnits: 0.3042,
};
const HP_RATIO = 1.6;
const AC_RATIO = (cdd) => 0.225 + (0.186 * cdd) / 1000;

const cop = (t) => Math.min(5, Math.max(2.3, 3.5 + 0.1 * (t - 2)));

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

const heatPumpUnits = (p) => p.spaceHeatCop.map((v, m) => v + p.hotWater[m] / DHW_COP);

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
  const scale = HP_RATIO / REF.hpKwhUnits;
  const total = p.house.slice();
  const add = (arr) => arr.forEach((v, m) => {
    total[m] += v;
  });
  if (heating === 'heat_pump') add(heatPumpUnits(p).map((v) => v * scale));
  if (heating === 'hybrid') add(p.warmHeatCop.map((v) => v * scale));
  if (heating === 'electric') add(p.spaceHeat.map((v, m) => (v + p.hotWater[m]) * scale));
  if (cooling) {
    const cddYear = climate.cdd.reduce((a, v) => a + v, 0);
    const houseYear = p.house.reduce((a, v) => a + v, 0);
    const cool = normalize(climate.cdd);
    if (cool) add(cool.map((v) => v * AC_RATIO(cddYear) * houseYear));
  }
  return normalize(total);
};

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
