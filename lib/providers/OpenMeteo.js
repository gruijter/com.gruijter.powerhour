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

const MODEL_WEIGHTS = {
  ecmwf_ifs: 1.5,
  meteofrance_seamless: 1.4,
  knmi_seamless: 1.3,
  icon_seamless: 1.2,
  ukmo_seamless: 1.2,
  metno_seamless: 1.2,
  gem_seamless: 1.1,
  gfs_seamless: 0.8,
};

class OpenMeteo {

  static getEnsembleModels(lat, lon) {
    const models = ['ecmwf_ifs', 'icon_seamless', 'gfs_seamless'];

    const numLat = Number(lat);
    const numLon = Number(lon);
    if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) return models;

    if (numLat >= 42 && numLat <= 58 && numLon >= -5 && numLon <= 16) {
      models.push('knmi_seamless', 'meteofrance_seamless');
    }
    if (numLat >= 49 && numLat <= 61 && numLon >= -11 && numLon <= 2) {
      if (!models.includes('ukmo_seamless')) models.push('ukmo_seamless');
    }
    if (numLat >= 54 && numLat <= 72 && numLon >= 4 && numLon <= 32) {
      if (!models.includes('metno_seamless')) models.push('metno_seamless');
    }
    if (numLon <= -50 && numLat >= 24 && numLat <= 75) {
      models.push('gem_seamless');
    }

    return models;
  }

  static async fetchForecast(lat, lon) {
    const models = OpenMeteo.getEnsembleModels(lat, lon);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&models=${models.join(',')}&forecast_days=2&past_days=1&timezone=UTC`;

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Open-Meteo API error: ${response.statusText}`);
    const data = await response.json();

    const result = {};
    if (data && data.hourly) {
      data.hourly.time.forEach((t, i) => {
        const time = new Date(`${t}Z`).getTime();

        let weightedSum = 0;
        let totalWeight = 0;
        models.forEach((model) => {
          const key = `shortwave_radiation_${model}`;
          const val = data.hourly[key] ? data.hourly[key][i] : null;
          if (val !== null && val !== undefined) {
            const weight = MODEL_WEIGHTS[model] || 1.0;
            weightedSum += val * weight;
            totalWeight += weight;
          }
        });

        if (totalWeight === 0 && data.hourly.shortwave_radiation) {
          weightedSum = data.hourly.shortwave_radiation[i];
          totalWeight = 1;
        }

        result[time] = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
      });
    }
    return result;
  }

  static async fetchEra5(lat, lon, start, end) {
    const era5Map = new Map();
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation&timezone=UTC`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const data = await response.json();
        if (data && data.hourly && data.hourly.time) {
          data.hourly.time.forEach((t, i) => {
            const rad = data.hourly.shortwave_radiation[i];
            if (typeof rad === 'number') {
              era5Map.set(new Date(`${t}:00Z`).getTime(), rad);
            }
          });
        }
      }
    } catch {
    }
    return era5Map;
  }

  static async fetchHistoric(lat, lon, startDate, endDate) {
    const formatDate = (date) => date.toISOString().split('T')[0];
    const start = formatDate(startDate);
    const end = formatDate(endDate);

    const now = new Date();
    const diffTime = Math.abs(now - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    let data;
    const models = OpenMeteo.getEnsembleModels(lat, lon);
    const modelsParam = `&models=${models.join(',')}`;

    const era5Promise = OpenMeteo.fetchEra5(lat, lon, start, end);

    try {
      if (diffDays <= 92) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation${modelsParam}&timezone=UTC&past_days=${diffDays}&forecast_days=2`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      }

      if (!data) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation${modelsParam}&timezone=UTC`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      }
    } catch {
    }

    if (!data) {
      try {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation&timezone=UTC`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      } catch {
      }
    }

    const resultMap = new Map();
    const processData = (d) => {
      if (d && d.hourly && d.hourly.time) {
        d.hourly.time.forEach((t, i) => {
          const time = new Date(`${t}Z`).getTime();
          let radiation = 0;

          let weightedSum = 0;
          let totalWeight = 0;
          models.forEach((model) => {
            const key = `shortwave_radiation_${model}`;
            const val = d.hourly[key] ? d.hourly[key][i] : null;
            if (val !== null && val !== undefined) {
              const weight = MODEL_WEIGHTS[model] || 1.0;
              weightedSum += val * weight;
              totalWeight += weight;
            }
          });

          if (totalWeight > 0) radiation = Math.round(weightedSum / totalWeight);
          else if (d.hourly.shortwave_radiation) radiation = d.hourly.shortwave_radiation[i];

          if (typeof radiation === 'number') {
            resultMap.set(time, radiation);
          }
        });
      }
    };

    processData(data);

    const era5Map = await era5Promise;
    if (era5Map.size > 0) {
      const settledCutoff = now.getTime() - (5 * 24 * 60 * 60 * 1000);
      for (const [time, ensembleRadiation] of resultMap.entries()) {
        if (time >= settledCutoff) continue;
        const era5Radiation = era5Map.get(time);
        if (era5Radiation === undefined) continue;
        resultMap.set(time, Math.round((ensembleRadiation * 0.5) + (era5Radiation * 0.5)));
      }
    }

    const result = [];
    for (const [time, radiation] of resultMap.entries()) {
      result.push({ time, radiation });
    }

    return result.sort((a, b) => a.time - b.time);
  }

}

module.exports = OpenMeteo;
