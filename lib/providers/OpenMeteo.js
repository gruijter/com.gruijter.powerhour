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
  ecmwf_ifs: 1.5, // Tier 1: Global gold standard (9km)
  meteofrance_seamless: 1.4, // Tier 1: Météo-France AROME (1.3km)
  knmi_seamless: 1.3, // Tier 1: KNMI Harmonie (2.5km)
  icon_seamless: 1.2, // Tier 2: DWD ICON (2.2km D2 / 7km EU)
  ukmo_seamless: 1.2, // Tier 2: UK Met Office (2km)
  metno_seamless: 1.2, // Tier 2: MET Norway (2.5km)
  gem_seamless: 1.1, // Tier 2: Environment Canada (2.5km)
  gfs_seamless: 0.8, // Tier 3: Global fallback (13km)
};

class OpenMeteo {

  static getEnsembleModels(lat, lon) {
    // 1. Global NWP Backbone (always active worldwide)
    const models = ['ecmwf_ifs', 'icon_seamless', 'gfs_seamless'];

    const numLat = Number(lat);
    const numLon = Number(lon);
    if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) return models;

    // 2. Benelux & West Europe (KNMI Harmonie 2.5km + Météo-France AROME 1.3km)
    if (numLat >= 42 && numLat <= 58 && numLon >= -5 && numLon <= 16) {
      models.push('knmi_seamless', 'meteofrance_seamless');
    }
    // 3. UK & Ireland (UK Met Office 2km)
    if (numLat >= 49 && numLat <= 61 && numLon >= -11 && numLon <= 2) {
      if (!models.includes('ukmo_seamless')) models.push('ukmo_seamless');
    }
    // 4. Scandinavia (MET Norway 2.5km)
    if (numLat >= 54 && numLat <= 72 && numLon >= 4 && numLon <= 32) {
      if (!models.includes('metno_seamless')) models.push('metno_seamless');
    }
    // 5. North America (Environment Canada GEM 2.5km)
    if (numLon <= -50 && numLat >= 24 && numLat <= 75) {
      models.push('gem_seamless');
    }

    return models;
  }

  static async fetchForecast(lat, lon) {
    // Fetch multiple top-tier models to create an ensemble average.
    // This reduces the impact of a single model being wrong (e.g. one predicts clear sky, another predicts heavy clouds).
    const models = OpenMeteo.getEnsembleModels(lat, lon);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&models=${models.join(',')}&forecast_days=2&past_days=1&timezone=UTC`;

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Open-Meteo API error: ${response.statusText}`);
    const data = await response.json();

    const result = {};
    if (data && data.hourly) {
      data.hourly.time.forEach((t, i) => {
        // Append Z to ensure the string is treated as UTC
        const time = new Date(`${t}Z`).getTime();

        // Calculate weighted average radiation across all requested models
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

        // Fallback to generic key if models failed (though API usually returns model-specific keys)
        if (totalWeight === 0 && data.hourly.shortwave_radiation) {
          weightedSum = data.hourly.shortwave_radiation[i];
          totalWeight = 1;
        }

        result[time] = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
      });
    }
    return result;
  }

  // ERA5 reanalysis (archive-api.open-meteo.com) is assimilated against real
  // observations, unlike the forecast-ensemble endpoint used elsewhere in this file
  // (which - even for "past" days - is still short-lead-time MODEL output, never
  // observations; confirmed against Open-Meteo's own team, see homey-app-development
  // skill). It takes ~5-7 days to settle, so it's only blended in for data older than
  // that. Best-effort: any failure here just means the caller falls back to
  // ensemble-only, never a hard error.
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
    } catch (err) {
      // Ignore - caller proceeds with ensemble-only radiation.
    }
    return era5Map;
  }

  static async fetchHistoric(lat, lon, startDate, endDate) {
    const formatDate = (date) => date.toISOString().split('T')[0];
    const start = formatDate(startDate);
    const end = formatDate(endDate);

    // Calculate days in the past to determine strategy
    const now = new Date();
    const diffTime = Math.abs(now - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    let data;
    // Use same ensemble models as fetchForecast for consistency
    const models = OpenMeteo.getEnsembleModels(lat, lon);
    const modelsParam = `&models=${models.join(',')}`;

    // Kick off the ERA5 fetch in parallel with the ensemble fetch below, so blending
    // it in doesn't add extra latency. Only ever used for entries 5+ days old (see
    // blending pass further down) - never covers Step 2's last-24h fine-tune data.
    const era5Promise = OpenMeteo.fetchEra5(lat, lon, start, end);

    try {
      // 1. Use Forecast API with past_days for recent history (<= 92 days).
      // This is more robust for "today" and "yesterday" data than using start_date/end_date on the forecast endpoint.
      if (diffDays <= 92) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation${modelsParam}&timezone=UTC&past_days=${diffDays}&forecast_days=2`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      }

      // 2. Fallback/Standard: If data not found yet (or > 92 days), try standard Forecast API with dates
      if (!data) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation${modelsParam}&timezone=UTC`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      }
    } catch (err) {
      // Ignore, fall through to Archive
    }

    // 3. Fallback to Archive API (Low resolution, long history, lags by ~5 days)
    if (!data) {
      try {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation&timezone=UTC`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) {
          data = await response.json();
        }
      } catch (e) {
        // Final failure
      }
    }

    const resultMap = new Map();
    const processData = (d) => {
      if (d && d.hourly && d.hourly.time) {
        d.hourly.time.forEach((t, i) => {
          const time = new Date(`${t}Z`).getTime();
          let radiation = 0;

          // Weighted ensemble averaging
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
          else if (d.hourly.shortwave_radiation) radiation = d.hourly.shortwave_radiation[i]; // Fallback for Archive API

          if (typeof radiation === 'number') {
            resultMap.set(time, radiation);
          }
        });
      }
    };

    processData(data);

    // Blend in ERA5 for entries old enough that it has settled (~5-7 days - see
    // fetchEra5's comment). 50/50 with the ensemble mean already computed above:
    // enough weight to meaningfully pull in ERA5's correction on days the ensemble
    // got wrong (confirmed empirically against a real device: ERA5 nearly halved the
    // day-to-day yield-factor spread at an affected slot), without letting a single
    // additional source fully override the existing multi-model ensemble on the
    // strength of a small validation sample. Recent entries (< 5 days old, including
    // all of Step 2's last-24h fine-tune data) are untouched - ERA5 has no data for
    // them yet.
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
