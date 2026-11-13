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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// astronomy-engine (~2.5 MB of memory with its code) only for the search, released after it.
const withAstronomy = (fn) => {
  const id = require.resolve('astronomy-engine');
  const Astronomy = require('astronomy-engine'); // eslint-disable-line global-require
  try {
    return fn(Astronomy);
  } finally {
    // Both references: the require cache and this module's list of children.
    delete require.cache[id];
    module.children = module.children.filter((child) => child.id !== id);
  }
};

// The search result per location, shared by the devices (one search a day, not one per device).
const shared = new Map();

// Weather-model radiation forecasts (Open-Meteo/ECMWF/GFS/ICON) don't model solar eclipses -
// they're a short, deterministic astronomical event outside normal NWP physics. This derives a
// local eclipse window once a day and uses it to knock down forecasted irradiance for the
// timestamps it actually covers, so an eclipse day doesn't silently forecast as a clear one.
class SolarEclipse {

  // Finds the next local solar eclipse (if any) visible from lat/lon, starting the search
  // slightly in the past so an eclipse already in progress isn't missed.
  static findNext(fromDate, lat, lon) {
    return withAstronomy((Astronomy) => {
      const observer = new Astronomy.Observer(Number(lat), Number(lon), 0);
      const eclipse = Astronomy.SearchLocalSolarEclipse(fromDate, observer);
      return {
        begin: eclipse.partial_begin.time.date.getTime(),
        peak: eclipse.peak.time.date.getTime(),
        end: eclipse.partial_end.time.date.getTime(),
        obscuration: eclipse.obscuration, // peak fraction of the sun's disc area covered by the moon
      };
    });
  }

  // findNext() from a day ago, at most once a day per location (also after a restart of a device).
  static findNextShared(now, lat, lon) {
    const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
    const hit = shared.get(key);
    if (hit && now - hit.checkedAt <= ONE_DAY_MS && !(hit.eclipse && now > hit.eclipse.end)) return hit.eclipse;
    let eclipse = null;
    try {
      eclipse = SolarEclipse.findNext(new Date(now - ONE_DAY_MS), lat, lon);
    } catch {
      eclipse = null;
    }
    shared.set(key, { checkedAt: now, eclipse });
    return eclipse;
  }

  // Irradiance multiplier (0-1) for a given time, given a known eclipse window. Ramps up/down
  // with a raised-sine bell rather than a hard-edged dip, matching the gradual first/last-contact-
  // to-max shape of a real eclipse instead of a sudden step.
  static irradianceMultiplier(t, eclipseWindow) {
    if (!eclipseWindow || !eclipseWindow.obscuration) return 1;
    const {
      begin, peak, end, obscuration,
    } = eclipseWindow;
    if (t <= begin || t >= end) return 1;
    const phase = t <= peak
      ? ((t - begin) / (peak - begin))
      : ((end - t) / (end - peak));
    const frac = Math.sin((Math.PI / 2) * phase) ** 2;
    return 1 - (obscuration * frac);
  }

  // Applies the eclipse multiplier to a { timestampMs: radiation } forecast map, returning a new
  // map. `cache` is a plain object owned by the caller (e.g. `this.eclipseCache` on a device) used
  // to avoid re-running the eclipse search on every hourly forecast fetch.
  static applyToForecast(forecastData, lat, lon, cache) {
    const now = Date.now();
    const stale = !cache.checkedAt || (now - cache.checkedAt) > ONE_DAY_MS;
    const expired = cache.eclipse && now > cache.eclipse.end;
    if (stale || expired) {
      cache.eclipse = SolarEclipse.findNextShared(now, lat, lon);
      cache.checkedAt = now;
    }
    if (!cache.eclipse) return forecastData;

    const result = {};
    Object.keys(forecastData).forEach((t) => {
      const multiplier = SolarEclipse.irradianceMultiplier(Number(t), cache.eclipse);
      result[t] = multiplier < 1 ? Math.round(forecastData[t] * multiplier) : forecastData[t];
    });
    return result;
  }

}

module.exports = SolarEclipse;
