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

// Climate of a location for the "Local climate" budget distribution, shared by all devices and
// kept in the app settings for a year: the last 10 full years of daily mean temperatures from
// Open-Meteo (ERA5), summarized per month, and the monthly PV yield from PVGIS (EU JRC). The
// location is rounded to 0.1° (~10 km). Null on failure: the device uses its fixed profile.

const ClimateProfile = require('../ClimateProfile');

const SETTINGS_KEY = 'climateNormals';
const MAX_AGE_MS = 365 * 24 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000;
const MAX_ENTRIES = 6;
const PV_TILT = 35;

const inflight = new Map();
const failedTm = new Map();

const round = (v) => Math.round(v * 10) / 10;

const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const fetchTemps = async (lat, lon) => {
  const year = new Date().getUTCFullYear();
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
    + `&start_date=${year - 10}-01-01&end_date=${year - 1}-12-31&daily=temperature_2m_mean&timezone=auto`;
  const data = await fetchJson(url);
  if (!data || !data.daily || !Array.isArray(data.daily.time)) throw new Error('no temperatures');
  const climate = ClimateProfile.summarize(data.daily.time, data.daily.temperature_2m_mean);
  if (climate.years < 5) throw new Error('too few years');
  return climate;
};

// Facing the equator: PVGIS's optimal angles are not usable south of the equator.
const fetchPv = async (lat, lon) => {
  const url = `https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=${lat}&lon=${lon}&peakpower=1&loss=14`
    + `&angle=${PV_TILT}&aspect=${lat >= 0 ? 0 : 180}&outputformat=json`;
  const data = await fetchJson(url);
  const monthly = data && data.outputs && data.outputs.monthly && data.outputs.monthly.fixed;
  if (!Array.isArray(monthly) || monthly.length !== 12) throw new Error('no PV yield');
  return monthly.map((m) => Math.round(m.E_m * 100) / 100);
};

/**
 * Cached climate data for a location, fetched when missing or older than a year.
 * @param {object} homey
 * @param {'temp'|'pv'} kind - temp: ClimateProfile.summarize(); pv: 12 monthly kWh per kWp
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|number[]|null>}
 */
const get = async (homey, kind, lat, lon) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${kind}|${round(lat)}|${round(lon)}`;
  const cache = homey.settings.get(SETTINGS_KEY) || {};
  const hit = cache[key];
  if (hit && Date.now() - hit.tm < MAX_AGE_MS) return hit.data;
  if (Date.now() - (failedTm.get(key) || 0) < RETRY_MS) return hit ? hit.data : null;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      try {
        const data = kind === 'pv' ? await fetchPv(round(lat), round(lon)) : await fetchTemps(round(lat), round(lon));
        const fresh = { ...(homey.settings.get(SETTINGS_KEY) || {}), [key]: { tm: Date.now(), data } };
        const keep = Object.keys(fresh).sort((a, b) => fresh[b].tm - fresh[a].tm).slice(0, MAX_ENTRIES);
        homey.settings.set(SETTINGS_KEY, Object.fromEntries(keep.map((k) => [k, fresh[k]])));
        return data;
      } catch (err) {
        failedTm.set(key, Date.now());
        homey.app.error(`Climate data (${kind}) for the budget failed:`, err.message || err);
        return hit ? hit.data : null;
      } finally {
        inflight.delete(key);
      }
    })());
  }
  return inflight.get(key);
};

module.exports = { get };
