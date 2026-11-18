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

const withAstronomy = (fn) => {
  const id = require.resolve('astronomy-engine');
  const Astronomy = require('astronomy-engine'); // eslint-disable-line global-require
  try {
    return fn(Astronomy);
  } finally {
    delete require.cache[id];
    module.children = module.children.filter((child) => child.id !== id);
  }
};

const shared = new Map();

class SolarEclipse {

  static findNext(fromDate, lat, lon) {
    return withAstronomy((Astronomy) => {
      const observer = new Astronomy.Observer(Number(lat), Number(lon), 0);
      const eclipse = Astronomy.SearchLocalSolarEclipse(fromDate, observer);
      return {
        begin: eclipse.partial_begin.time.date.getTime(),
        peak: eclipse.peak.time.date.getTime(),
        end: eclipse.partial_end.time.date.getTime(),
        obscuration: eclipse.obscuration,
      };
    });
  }

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
