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

const TimeHelpers = require('../helpers/TimeHelpers');
const { estimateClearSkyGHI } = require('../helpers/ClearSkyGHI');

// BUG FOUND AND FIXED (2026-08-15, real device data): Open-Meteo timestamps shortwave_radiation
// (and the other radiative variables, across every model this app queries - confirmed
// individually for ecmwf_ifs, icon_seamless, gfs_seamless, knmi_seamless, meteofrance_seamless,
// ukmo_seamless and metno_seamless) at the END of the averaged hour, not an instant at the
// timestamp itself: https://github.com/open-meteo/open-meteo/discussions/1556 - "instantaneous
// variables represent a value at the start of the hour... shortwave_radiation... represent an
// average... over the previous hour, so the timestamp marks the end of that hour". The stored
// key K's true representative instant is therefore K-30min (the averaged hour's midpoint), not K.
// Every weather map this function reads (forecastData, weatherMap in extraction) has always
// been built with raw, hour-aligned (:00) keys straight from the API - that's relied on
// elsewhere (e.g. this file's own weatherMap construction rounds query timestamps down to the
// hour before using them as keys), so the correct fix is here, at the single shared read path,
// not by shifting the stored keys themselves. Shifting the query forward by 30min before
// hour-flooring is mathematically equivalent to correctly treating the value stored at raw key K
// as valid at K-30min. Verified against real device data: the interpolated curve's own up/down
// half-max symmetry point was 30.5min later than the astronomically-computed true solar noon for
// the same lat/lon/date before this fix.
const RADIATION_TIMESTAMP_CORRECTION_MS = 30 * 60 * 1000;

const getInterpolatedRadiation = (timestamp, weatherData) => {
  const rawT = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const t = rawT + RADIATION_TIMESTAMP_CORRECTION_MS;
  const date = new Date(t);
  date.setUTCMinutes(0, 0, 0, 0);
  const t1 = date.getTime();
  const t2 = t1 + 3600000;

  const r1 = weatherData instanceof Map ? weatherData.get(t1) : weatherData[t1];
  const r2 = weatherData instanceof Map ? weatherData.get(t2) : weatherData[t2];

  if (r1 === undefined && r2 === undefined) return 0;
  if (r1 === undefined) return r2;
  if (r2 === undefined) return r1;

  const ratio = (t - t1) / 3600000;
  return r1 + (r2 - r1) * ratio;
};

// Clear-sky weighting via power-curve roughness - TRIED AND REVERTED (2026-08-14):
// a per-(date, 15-min slot) "clearness" score (total variation / range of power
// over a ~1h window - smooth trajectories near 1, erratic cloud-driven ones much
// higher) was built and used to weight ramp-region/normal-region sample selection
// toward confirmed-clear samples. Confirmed on a real device that the roughness
// metric itself works as a smoothness detector (clear ramps and a genuine
// roof-ridge shadow transition both scored 1.00-1.24; synthetic cloud-like noise
// on the same data scored 6.28) - but rejected anyway before shipping: smoothness
// alone cannot distinguish genuinely clear sky from uniform, unchanging overcast
// (steady overcast is smooth too, just dimmer - it's scattered/broken cloud that
// actually reads as rough). Comparing against this device's own current
// yieldFactor prediction was considered as an extra filter, but that's circular:
// the prediction is exactly what this mechanism would exist to correct. No
// reliably non-circular way to close this gap was found with the data actually
// available (device power + modeled radiation only, no independent sky/irradiance
// sensor) - not a bug to fix, the core detection signal itself isn't trustworthy
// enough to act on. Removed rather than left in place unused, per feedback: don't
// keep speculative machinery running for a signal nobody trusts yet.
//
// ADOPTED INSTEAD (2026-08-15): stop trying to classify "was this clear sky" at all -
// the attempt above and the region-split/top-25%-cutoff/isCloudy-gate machinery it would
// have replaced share the same flaw, trying to infer a *global* sky-condition label from
// data that can't reliably support one. Reframed as a *local* question instead: "did the
// forecast radiation track reality over this short window", checkable without ever
// labeling sky condition - genuinely clear days and stable/overcast days are both easy to
// forecast (low dispersion in the power/forecastRadiation ratio); patchy or misforecast
// periods are hard to forecast (high dispersion), regardless of whether they're nominally
// "clear" or "cloudy". This escapes all three rejected directions above: it never uses
// radiation as sole ground truth (dispersion is scored on the ratio, not radiation alone),
// never assumes a curve shape (a real structural-shadow step scores as two clean segments
// either side of one ambiguous transition sample, not "rough"), and never compares against
// the model being trained (only against nearby raw samples). See extractSlotSamples()/
// aggregateYieldFactors() below - live learning (getStrategy(), formerly in this file) was
// also removed this session: with yieldFactors indexed by fixed time-of-day slot, a live
// update at 08:00 today only ever affects tomorrow's 08:00 forecast, never today's own
// later forecast, so it was largely redundant with (and noisier than) this nightly batch
// retrain, which is now the sole source of truth for the model.

const detectCurtailment = ({
  currentPower,
  lastPower,
  forecastData,
  yieldFactors,
  isCurtailmentActive,
  timestamp = new Date(),
  manualCurtailment = false,
  peakPower = 0,
}) => {
  const result = {
    isActive: isCurtailmentActive,
    log: null,
    changed: false,
  };

  const forecastRadiation = getInterpolatedRadiation(timestamp, forecastData);
  const slotIndex = (timestamp.getUTCHours() * 4) + Math.floor(timestamp.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = forecastRadiation * yieldFactor;

  const systemPeak = peakPower > 0 ? peakPower : Math.max(1000, ...yieldFactors.map((y) => y * 1000));

  // 1. isCloudy Detection (Rolling Window)
  // Check radiation in a +/- 2 hour window. If it drops below 300 W/m²,
  // there are clouds (or twilight) nearby. Protects against time-shifted forecasts.
  let minRadiationInWindow = forecastRadiation;
  for (let offset = -2; offset <= 2; offset++) {
    const t = timestamp.getTime() + (offset * 3600000);
    const rad = getInterpolatedRadiation(t, forecastData);
    if (rad < minRadiationInWindow) minRadiationInWindow = rad;
  }
  const isCloudy = minRadiationInWindow < 300;

  // 2. Detection Thresholds (Turning ON)
  const baseMinExpected = Math.max(250, systemPeak * 0.05);
  // Require higher expected power to trigger curtailment if clouds are nearby (avoids false drops)
  const triggerExpected = isCloudy ? baseMinExpected * 2 : baseMinExpected;

  const offThreshold = 20; // W - Power below this is considered 'off'

  const wasRunningThreshold = Math.max(50, systemPeak * 0.02); // W

  if (expectedPower > triggerExpected && currentPower < offThreshold && lastPower > wasRunningThreshold) {
    if (!isCurtailmentActive) {
      result.isActive = true;
      result.changed = true;
      result.log = `Curtailment detected: Expected ${Math.round(expectedPower)}W, Actual ${Math.round(currentPower)}W`;
    }
  } else if (isCurtailmentActive) {
    if (manualCurtailment) return result; // Manual override, never auto-recover

    // 3. Recovery Thresholds (Turning OFF)
    // Strict relative rule: 80% of current expected power
    const relativeRecovery = expectedPower * 0.8;
    // Absolute bypass: undeniably online if producing > 10% of peak (min 250W)
    const absoluteRecovery = Math.max(250, systemPeak * 0.10);
    // Use the lowest of the two. This guarantees recovery on wrong forecasts (absolute bypass),
    // while remaining sensitive enough for genuinely dark days (relative rule).
    const recoveryThreshold = Math.min(relativeRecovery, absoluteRecovery);

    if (currentPower >= recoveryThreshold) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Power restored to ${Math.round(currentPower)}W (Threshold: ${Math.round(recoveryThreshold)}W)`;
    } else if (!manualCurtailment && expectedPower < 100) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Low expected power (${Math.round(expectedPower)}W)`;
    }
  }

  return result;
};

const calculateSmoothedPower = ({
  currentPower,
  currentEnergy,
  lastEnergyState,
  currentTimestamp,
}) => {
  let smoothedPower = currentPower;
  const newEnergyState = { time: currentTimestamp, energy: currentEnergy };

  if (typeof currentEnergy === 'number' && lastEnergyState && lastEnergyState.time) {
    const dTime = currentTimestamp - lastEnergyState.time;
    const dEnergy = currentEnergy - lastEnergyState.energy;
    // Only use energy-derived power if the real-time 'measure_power' is missing.
    // Calculating power from coarse energy steps (e.g., 0.05 kWh) over short 1-minute
    // intervals creates massive artificial math spikes (0.05 kWh / 1 min = 3000W).
    if ((typeof currentPower !== 'number' || Number.isNaN(currentPower)) && dTime > 50000 && dEnergy > 0) {
      const avgPower = (dEnergy / (dTime / 3600000)) * 1000; // kWh -> W
      smoothedPower = avgPower;
    }
  }
  return { smoothedPower, newEnergyState };
};

// Confidence weighting constants (see the design note near the top of this file for why
// these replace the old region-split/top-25%-cutoff/isCloudy-gate machinery).
const CONFIDENCE_EPSILON = 0.0001; // Measurement-precision floor (~1% relative), not a tuned knob.
const CLEAR_SKY_ADMISSION_FRACTION = 0.05; // Loose floor (not a classifier): admit if >5% of theoretical clear-sky GHI.
const HOURLY_MIDPOINT_SHIFT_MS = 30 * 60 * 1000; // Verified (2d4cc72b): hourly entry.t = hour start, value = hour midpoint.
const FIVE_MIN_MIDPOINT_SHIFT_MS = 2.5 * 60 * 1000; // ASSUMED, not independently verified - see note above.
// BUG FOUND AND FIXED (2026-08-15, real device data - see git history/session log): a single
// near-sunrise 5-min sample (radiation ~14 W/m2) got weight=7230 - ~115x every other sample in
// its slot - and single-handedly dragged a 13-day, 13-sample consensus (yf 1.38-2.58) down to
// its own value. Root cause: at near-zero radiation, a day's own +-30min window can look
// almost perfectly linear (power ramping gently from near-zero) even though the underlying
// power/radiation RATIO is inherently unstable there (small denominator amplifies any
// absolute noise into large relative swings) - confirmed on the same real data: 13 independent
// days' worth of hourly samples at this exact time-of-day spread from 1.38 to 2.58, so "smooth
// within one day's narrow window" clearly does NOT mean "reliable ratio," it can just mean
// "the absolute numbers involved are still tiny and slowly changing." A purely relative
// dispersion measure (MAD/median(r)) cannot tell these apart on its own. Below this radiation,
// always defer to the self-calibrated fallback weight (see extractSlotSamples) instead of a
// freshly computed one - matches the noise-floor threshold already used elsewhere in this file
// (the entriesWithYield noise-floor filter above).
const MIN_RADIATION_FOR_CONFIDENCE = 50; // W/m2
const HIGH_RES_WINDOW_MS = 30 * 60 * 1000; // +-30 min local window for 5-min-resolution confidence scoring.
const HIGH_RES_GAP_BREAK_MS = 15 * 60 * 1000; // Window stops at any gap larger than this between raw samples.

// Weighted percentile over samples pre-sorted ascending by `.yieldFactor`, each carrying a
// `.weight`. Used both for the per-slot median (p=0.5) and the global p90 limit - the
// confidence-weighted generalization of "sort and take the middle/near-top value".
const weightedPercentile = (sortedSamples, totalWeight, p) => {
  if (sortedSamples.length === 0 || totalWeight <= 0) return 0;
  const target = p * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < sortedSamples.length; i += 1) {
    cumulative += sortedSamples[i].weight;
    if (cumulative >= target) return sortedSamples[i].yieldFactor;
  }
  return sortedSamples[sortedSamples.length - 1].yieldFactor;
};

// BUG FOUND AND FIXED (2026-08-15, real device data - see the note in extractSlotSamples()
// for why capping at extraction time doesn't work): a single sample's confidence weight is
// unbounded above in principle, and real 5-minute daytime data makes near-ceiling weights
// common rather than rare - so a per-run "cap relative to the typical weight" does nothing
// when the typical weight is already near that ceiling. Confirmed on real data: one 5-minute
// sample outweighed 13 independent days' worth of hourly consensus for the same slot outright.
// The bound that actually holds regardless of the underlying weight distribution: no single
// sample may outweigh *the combined weight of every other sample competing for the same slot*.
// Capping each weight at half of "everyone else combined" guarantees any one sample can reach
// at most 1/3 of the slot's final total weight - comfortably short of being able to set a
// weighted median on its own, while still letting a genuinely well-supported reading count for
// more than a shakier one.
const capOutlierWeights = (samples) => {
  const total = samples.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return samples;
  return samples.map((s) => {
    const others = total - s.weight;
    const cap = others * 0.5;
    return (cap > 0 && s.weight > cap) ? { ...s, weight: cap } : s;
  });
};

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// Confidence for a single hourly sample from its raw {prev, this, next} triplet (1h spacing -
// the finest granularity hourly-origin data actually has). Scores the residual from the
// straight-line prediction through prev/next, not raw variance, so the genuinely fast, smooth
// ratio change near sunrise/sunset isn't misread as noise. Returns null if a usable triplet
// isn't available (missing/gapped/clipped neighbor) - caller falls back to the
// self-calibrated neutral weight (see extractSlotSamples).
const computeHourlyConfidence = (rPrev, rThis, rNext) => {
  const rPred = (rPrev + rNext) / 2;
  const meanAbs = (Math.abs(rPrev) + Math.abs(rThis) + Math.abs(rNext)) / 3;
  if (!(meanAbs > 0)) return null;
  const rcv = Math.abs(rThis - rPred) / meanAbs;
  return 1 / ((rcv * rcv) + CONFIDENCE_EPSILON);
};

// Confidence for a single 5-minute sample from a local +-30min window of raw
// (power/radiation) ratios. Fits a local linear trend (least squares) and scores the
// residual via MAD (robust to a single glitch skewing the whole window), normalized by the
// window's own median ratio. Returns null if the window has too few points to fit
// meaningfully (edge of the fetched range, missing/clipped neighbors).
const computeHighResConfidence = (windowPoints) => {
  const n = windowPoints.length;
  if (n < 4) return null;

  const t0 = windowPoints[0].t;
  let sumT = 0; let sumR = 0; let sumTT = 0; let sumTR = 0;
  windowPoints.forEach(({ t, r }) => {
    const dt = t - t0;
    sumT += dt; sumR += r; sumTT += dt * dt; sumTR += dt * r;
  });
  const denom = (n * sumTT) - (sumT * sumT);
  let slope = 0;
  let intercept = sumR / n;
  if (Math.abs(denom) > 1e-9) {
    slope = ((n * sumTR) - (sumT * sumR)) / denom;
    intercept = (sumR - (slope * sumT)) / n;
  }

  const residuals = windowPoints.map(({ t, r }) => Math.abs(r - (intercept + (slope * (t - t0)))));
  const mad = median(residuals);
  const medianR = median(windowPoints.map(({ r }) => r));
  if (!(Math.abs(medianR) > 0)) return null;

  const rcv = (1.4826 * mad) / Math.abs(medianR);
  return 1 / ((rcv * rcv) + CONFIDENCE_EPSILON);
};

// Gathers the raw (power/radiation) ratio points within +-30min of entriesWithYield[i],
// stopping at any >15min gap between consecutive accepted raw samples (a real discontinuity
// in the data, not a window this local-consistency check should straddle). Every point uses
// midpoint-shifted radiation (see FIVE_MIN_MIDPOINT_SHIFT_MS), including the center sample.
const buildHighResWindow = (entriesWithYield, isClipped, i, weatherMap) => {
  const centerT = entriesWithYield[i].timestamp.getTime();
  const points = [];

  let cursorT = centerT;
  for (let j = i; j >= 0; j -= 1) {
    const e = entriesWithYield[j];
    if (!e || isClipped[j]) break;
    if (centerT - e.timestamp.getTime() > HIGH_RES_WINDOW_MS) break;
    if (cursorT - e.timestamp.getTime() > HIGH_RES_GAP_BREAK_MS) break;
    const midT = e.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
    const r = getInterpolatedRadiation(midT, weatherMap);
    if (r > 10) points.unshift({ t: midT, r: e.power / r });
    cursorT = e.timestamp.getTime();
  }

  cursorT = centerT;
  for (let j = i + 1; j < entriesWithYield.length; j += 1) {
    const e = entriesWithYield[j];
    if (!e || isClipped[j]) break;
    if (e.timestamp.getTime() - centerT > HIGH_RES_WINDOW_MS) break;
    if (e.timestamp.getTime() - cursorT > HIGH_RES_GAP_BREAK_MS) break;
    const midT = e.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
    const r = getInterpolatedRadiation(midT, weatherMap);
    if (r > 10) points.push({ t: midT, r: e.power / r });
    cursorT = e.timestamp.getTime();
  }

  return points;
};

// Step 1/2 of the nightly retrain: turns raw Homey Insights power entries + OpenMeteo
// radiation into per-slot (power, radiation, yieldFactor, weight) samples. Replaces the old
// processHistoricData's region-split/top-25%-cutoff/isCloudy-gate clear-sky classification
// with a continuous per-sample confidence weight - see the design note near the top of this
// file for why ("did the forecast track reality locally", not "was this clear sky").
const extractSlotSamples = ({
  powerEntries, // Array of { t: string (ISO), y: number (Watt) } from Homey Insights
  weatherEntries, // Array of { time: number (ms), radiation: number (W/m2) } from OpenMeteo
  resolution, // 'hourly' (last14Days) | 'high' (last24Hours, 5-min)
  peakPower = 0,
  lat,
  lon,
  logger = () => {},
}) => {
  const weatherMap = new Map();
  weatherEntries.forEach((w) => {
    const date = new Date(w.time);
    date.setUTCMinutes(0, 0, 0);
    weatherMap.set(date.getTime(), w.radiation);
  });

  // Pre-calculate yield factors and detect clipping (unchanged from before).
  const entriesWithYield = powerEntries.map((entry) => {
    let power = entry.y !== undefined ? entry.y : entry.v;
    if (typeof power !== 'number' || power < 0 || power > 100000) return null;

    if (peakPower > 0) {
      if (power > peakPower * 1.1) return null; // Reject physical impossibilities
      if (power > peakPower) power = peakPower;
    }

    const timestamp = new Date(entry.t);
    const radiation = getInterpolatedRadiation(timestamp.getTime(), weatherMap);
    if (radiation < 10) return null;

    // Noise Floor Filter: very low radiation (<50) with <10W power is just dawn/dusk sensor
    // noise. If power is <10W but radiation implies daylight, keep it - that's how severe
    // structural shading (yield near 0) gets learned.
    if (power < 10 && radiation < 50) return null;

    const yieldFactor = power / radiation;
    return {
      power, radiation, yieldFactor, timestamp,
    };
  });

  const isClipped = new Array(entriesWithYield.length).fill(false);
  for (let i = 1; i < entriesWithYield.length - 1; i += 1) {
    const prev = entriesWithYield[i - 1];
    const curr = entriesWithYield[i];
    const next = entriesWithYield[i + 1];
    if (!prev || !curr || !next) continue;

    const pMin = Math.min(prev.power, curr.power, next.power);
    const pMax = Math.max(prev.power, curr.power, next.power);
    const pAvg = (prev.power + curr.power + next.power) / 3;
    if ((pMax - pMin) < Math.max(10, pAvg * 0.01)) {
      const yMin = Math.min(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yMax = Math.max(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yAvg = (prev.yieldFactor + curr.yieldFactor + next.yieldFactor) / 3;
      if ((yMax - yMin) > (yAvg * 0.03)) isClipped[i] = true;
    }
  }
  logger(`[extractSlotSamples:${resolution}] Clipping detection: found ${isClipped.filter(Boolean).length} clipped samples.`);

  const slotSamples = new Array(96).fill(0).map(() => []);
  const computed = []; // Samples with a freshly computed (pre-cap) weight
  const pending = []; // Samples whose window was too small to score directly

  const admitSample = (radiation, timestampMs) => {
    if (!(radiation > 10)) return false;
    const clearSky = estimateClearSkyGHI(timestampMs, lat, lon);
    if (clearSky > 0 && !(radiation > clearSky * CLEAR_SKY_ADMISSION_FRACTION)) return false;
    return true;
  };

  const pushSample = (idx, power, radiation, weight, timestamp, isFallback) => {
    if (idx < 0 || idx >= 96) return;
    const yieldFactor = power / radiation;
    if (!(yieldFactor >= 0 && yieldFactor < 500.0)) return;
    slotSamples[idx].push({
      yieldFactor, weight, power, radiation, timestamp, isFallback,
    });
  };

  if (resolution === 'high') {
    for (let i = 0; i < entriesWithYield.length; i += 1) {
      const item = entriesWithYield[i];
      if (!item || isClipped[i]) continue;

      const midT = item.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
      const midRadiation = getInterpolatedRadiation(midT, weatherMap);
      if (midRadiation <= 10 || !admitSample(midRadiation, midT)) continue;

      const slotIndex = (new Date(midT).getUTCHours() * 4) + Math.floor(new Date(midT).getUTCMinutes() / 15);
      // Below MIN_RADIATION_FOR_CONFIDENCE, never trust a freshly computed score - see the
      // constant's comment for why (a single day's window can look deceptively smooth there).
      const windowPoints = midRadiation >= MIN_RADIATION_FOR_CONFIDENCE
        ? buildHighResWindow(entriesWithYield, isClipped, i, weatherMap) : [];
      const weight = computeHighResConfidence(windowPoints);

      if (weight === null) {
        pending.push({
          idx: slotIndex, power: item.power, radiation: midRadiation, timestamp: item.timestamp,
        });
      } else {
        computed.push({
          idx: slotIndex, power: item.power, radiation: midRadiation, weight, timestamp: item.timestamp,
        });
      }
    }
  } else {
    // Homey's 'last7Days'/'last14Days' hourly entries for this log are the AVERAGE power over
    // the hour STARTING at the entry's timestamp - confirmed against a real device by matching
    // a 14-day hourly export against its overlapping 24h 5-minute export: the hourly value
    // equals the exact mean of that hour's twelve 5-minute samples, to 5 decimal places. So
    // each entry best represents its hour's MIDPOINT, not its start. Model the curve as
    // piecewise-linear through consecutive hour-midpoints (prev, this, next) and read the 4
    // quarter-hour slots off that: slot 0 (hour start) and slot 1 sit between prev's and this
    // hour's midpoint, slot 2 (half past) IS this hour's own midpoint value, slot 3 sits
    // between this hour's and next's midpoint. Falls back to the flat value on either side
    // when that neighbor is missing, gapped, or clipped.
    for (let i = 0; i < entriesWithYield.length; i += 1) {
      const item = entriesWithYield[i];
      if (!item || isClipped[i]) continue;

      const slotIndex = (item.timestamp.getUTCHours() * 4) + Math.floor(item.timestamp.getUTCMinutes() / 15);
      const prev = entriesWithYield[i - 1];
      const next = entriesWithYield[i + 1];
      const prevOk = !!prev && !isClipped[i - 1]
        && (item.timestamp.getTime() - prev.timestamp.getTime()) === 3600000;
      const nextOk = !!next && !isClipped[i + 1]
        && (next.timestamp.getTime() - item.timestamp.getTime()) === 3600000;

      // One confidence score per raw hour (the finest granularity hourly-origin data has),
      // applied identically to all 4 quarter-hour sub-samples derived from it.
      let weight = null;
      if (prevOk && nextOk) {
        const radThis = getInterpolatedRadiation(item.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        const radPrev = getInterpolatedRadiation(prev.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        const radNext = getInterpolatedRadiation(next.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        // Below MIN_RADIATION_FOR_CONFIDENCE, never trust a freshly computed score - see the
        // constant's comment for why (a single day's window can look deceptively smooth there).
        if (radThis >= MIN_RADIATION_FOR_CONFIDENCE && radPrev >= MIN_RADIATION_FOR_CONFIDENCE
          && radNext >= MIN_RADIATION_FOR_CONFIDENCE) {
          weight = computeHourlyConfidence(prev.power / radPrev, item.power / radThis, next.power / radNext);
        }
      }
      const subPowers = [
        prevOk ? (prev.power + item.power) / 2 : item.power, // :00
        prevOk ? (prev.power * 0.25) + (item.power * 0.75) : item.power, // :15
        item.power, // :30 - the hour's own midpoint
        nextOk ? (item.power * 0.75) + (next.power * 0.25) : item.power, // :45
      ];

      for (let k = 0; k < 4; k += 1) {
        const subTime = item.timestamp.getTime() + k * 900000;
        const subRadiation = getInterpolatedRadiation(subTime, weatherMap);
        if (!admitSample(subRadiation, subTime)) continue;
        if (weight === null) {
          pending.push({
            idx: slotIndex + k, power: subPowers[k], radiation: subRadiation, timestamp: new Date(subTime),
          });
        } else {
          computed.push({
            idx: slotIndex + k, power: subPowers[k], radiation: subRadiation, weight, timestamp: new Date(subTime),
          });
        }
      }
    }
  }

  // Self-calibrated fallback for samples whose local window was too small to score directly:
  // the median confidence weight actually computed elsewhere in this run, not a new magic
  // constant. With very little data (bootstrap), `computed` may be empty entirely - fall back
  // to a neutral weight of 1, so every sample counts equally and the weighted median below
  // degenerates to a plain median (never NaN/stuck).
  //
  // NOTE: individually capping outlier weights here (e.g. "at N times this run's own median")
  // was tried and abandoned - real 5-minute daytime data turns out to make near-perfect local
  // linear fits the NORM, not the exception (a stable-weather ramp genuinely is that smooth
  // minute-to-minute), so the median computed weight often already sits right at the
  // confidence ceiling itself. Capping relative to a same-scale median does nothing in that
  // case. The actual fix for a single outlier dominating a slot's result lives in
  // aggregateYieldFactors(), where weight is capped relative to the OTHER samples actually
  // competing for the same slot - a bound that holds regardless of this run's overall weight
  // distribution. See capOutlierWeights() there.
  const fallbackWeight = computed.length > 0 ? median(computed.map((c) => c.weight)) : 1;
  computed.forEach((c) => pushSample(c.idx, c.power, c.radiation, c.weight, c.timestamp, false));
  pending.forEach((p) => pushSample(p.idx, p.power, p.radiation, fallbackWeight, p.timestamp, true));

  let maxPowerSeen = 0;
  powerEntries.forEach((e) => {
    const p = e.y !== undefined ? e.y : e.v;
    if (typeof p === 'number' && p > maxPowerSeen) maxPowerSeen = p;
  });

  const sampleCount = slotSamples.reduce((sum, s) => sum + s.length, 0);
  const filledSlots = slotSamples.filter((s) => s.length > 0).length;
  logger(`[extractSlotSamples:${resolution}] Extracted ${sampleCount} samples across ${filledSlots} slots `
    + `(fallback weight=${fallbackWeight.toFixed(2)}, used by ${pending.length} samples).`);

  return { slotSamples, maxPowerSeen };
};

// Step 3 of the nightly retrain: aggregates the (already confidence-weighted) per-slot samples
// - typically the concatenation of a 'hourly' and a 'high' extractSlotSamples() call - into a
// single yieldFactors[96] model via weighted median. Replaces the old two-pass
// Step1-ratchets-Step2 reconciliation (up/down blend, isCloudy gate) - with one combined pass,
// a locally-inconsistent (patchy-cloud or misforecast) sample just carries less weight, no
// separate gate/blend logic needed.
const aggregateYieldFactors = ({
  combinedSlotSamples, // Array(96) of samples from extractSlotSamples(), concatenated across calls
  peakPower = 0,
  logger = () => {},
}) => {
  // Global limit: weighted ~90th percentile yieldFactor among reasonably-radiated samples -
  // mirrors the old datasetMaxYF, now weight-based instead of a raw top-25%-by-power cut.
  // Kept as a softer, data-derived backstop alongside the (unchanged) peakPower physical
  // ceiling below - useful in particular when peakPower isn't configured.
  const highRadiationSamples = [];
  combinedSlotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation > 100) highRadiationSamples.push(s);
    });
  });
  let datasetMaxYF = 0;
  if (highRadiationSamples.length > 0) {
    const capped = capOutlierWeights(highRadiationSamples);
    const sorted = capped.sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);
    datasetMaxYF = weightedPercentile(sorted, totalWeight, 0.90);
    logger(`[aggregateYieldFactors] Global limit (weighted p90): ${highRadiationSamples.length} samples, datasetMaxYF=${datasetMaxYF.toFixed(3)}`);
  }

  const newYieldFactors = new Array(96).fill(null);
  const trainingConfidence = new Array(96).fill(0);

  combinedSlotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    // Cap each sample's weight relative to the others competing for this same slot - see
    // capOutlierWeights() for why this (not a run-wide cap) is what actually bounds a single
    // outlier's influence on this slot's median.
    const sorted = capOutlierWeights(samples).sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);

    // p75, not the median (p50) - confirmed against a real device on a 100% clear-sky day
    // (2026-08-15): the median of a 14-day confidence-weighted window reflects "typical"
    // production, which is systematically LOWER than a clear-sky day's actual output whenever
    // most of the window wasn't fully clear (a stable-overcast afternoon is just as
    // high-confidence as a clear one - it gets a comparable weight, not a lower one - so the
    // median settles on "typical," not "best-case"). The old algorithm's "top 25% by power,
    // then median" had this clear-sky bias built in deliberately; p75 is the confidence-
    // weighted equivalent of that same bias, restoring "clear-sky days are the most reliable
    // reference" without reintroducing the old top-25%-cutoff/region-split machinery.
    //
    // BUG FOUND AND FIXED (2026-08-15, synthetic regression test): a flat p75 is measurably
    // easier for a single uncrushed outlier to reach than p50 was, precisely because it sits
    // closer to the top of the distribution - confirmed with a synthetic 25%-spike-rate slot
    // with only 3 samples: the spike's weight wasn't crushed enough (its own local window was
    // itself corrupted by nearby spikes, so confidence couldn't cleanly separate it), and
    // p75 landed directly on it (spike sat in the top 30% of cumulative weight, p50 didn't
    // reach that far). Real 14-day retrains have 13-17 samples/slot and don't show this - the
    // risk is specific to low sample counts (bootstrap, rarely-admitted slots). Fix: blend the
    // target percentile toward p50 when a slot has few samples, only trusting the full p75
    // once there's enough independent corroborating data that one bad sample can't swing it.
    const MIN_SAMPLES_FOR_FULL_PERCENTILE = 10;
    const percentileBlend = Math.min(1, sorted.length / MIN_SAMPLES_FOR_FULL_PERCENTILE);
    const targetPercentile = 0.50 + (0.25 * percentileBlend);
    let best = weightedPercentile(sorted, totalWeight, targetPercentile);

    const bestSample = sorted.reduce((closest, s) => (
      Math.abs(s.yieldFactor - best) < Math.abs(closest.yieldFactor - best) ? s : closest
    ), sorted[0]);

    // Safety cap: the data-derived global limit (softer)...
    let limit = 500.0;
    if (datasetMaxYF > 0) limit = datasetMaxYF * 1.25;

    // ...loosened by a per-slot physical ceiling anchored to the array's own known peak
    // capacity, evaluated at THIS sample's own radiation (unchanged from before - never makes
    // the cap tighter, Math.max, so it can only stop wrongly clamping legitimate ramp-hour
    // values near sunrise/sunset, not weaken protection against actually impossible ones).
    if (peakPower > 0 && bestSample.radiation > 0) {
      const physicalCeiling = (peakPower * 1.1) / bestSample.radiation;
      limit = Math.max(limit, physicalCeiling);
    }

    if (best > limit) best = limit;

    // Training confidence: what fraction of the verified (non-fallback), day-grouped
    // observations for this slot actually agree with the final selected value - directly
    // answers "if I trust this forecast, how often would the training data itself have
    // matched it", rather than an abstract statistical count.
    //
    // BUG FOUND AND FIXED (2026-08-15, visual check against a real device's rendered chart): a
    // slot where every sample fell back to the same self-calibrated neutral weight (always the
    // very first/last daylight slot of the day, since the hourly triplet's "prev"/"next" is
    // pre-dawn/post-dusk and can never yield a real score) scored ~93% confidence - the
    // HIGHEST of the entire day - purely because equal weights maximize a naive effective
    // sample size, regardless of WHY they were equal, right where this session's work has been
    // about NOT trusting blindly. Fix: exclude fallback samples entirely - they still fully
    // participate in the yieldFactor estimate itself, just don't count as earned confidence.
    //
    // BUG FOUND AND FIXED (2026-08-15, real device data - user flagged a 100%-fit forecast day
    // reading only ~30-50% confidence): effective-sample-size on the raw per-sample weights
    // was tried next, day-grouped to stop Step 2's same-day 5-minute samples from
    // multiply-counting one day as several. Still read low: the confidence WEIGHT formula
    // (1/rcv^2, see computeHourlyConfidence/computeHighResConfidence) is steeply nonlinear, so
    // ordinary day-to-day noise differences - even among days that plainly agree on the
    // resulting yieldFactor - produce weight ratios of 100x or more, and effective-sample-size
    // ends up dominated by whichever handful of days happened to have the least noise,
    // understating slots where the underlying VALUES actually agree well. Fix: measure
    // agreement directly on the yieldFactor values themselves (which don't inherit that
    // extreme sensitivity) against a tolerance band around the slot's own final selected
    // value, weighted by each day's own confidence so a shaky day doesn't count fully either
    // way - a directly interpretable "what fraction of the training data backs this number up".
    const CONFIDENCE_AGREEMENT_TOLERANCE = 0.15; // +-15% of the final selected value
    const verified = sorted.filter((s) => !s.isFallback);
    const byDay = new Map();
    verified.forEach((s) => {
      const day = new Date(s.timestamp).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { weightSum: 0, yfWeightedSum: 0 });
      const entry = byDay.get(day);
      entry.weightSum += s.weight;
      entry.yfWeightedSum += s.weight * s.yieldFactor;
    });
    const perDay = [...byDay.values()].map((e) => ({
      weight: e.weightSum,
      yieldFactor: e.yfWeightedSum / e.weightSum,
    }));
    const totalDayWeight = perDay.reduce((sum, d) => sum + d.weight, 0);
    if (totalDayWeight > 0 && best > 0) {
      const agreeingWeight = perDay.reduce((sum, d) => {
        const withinTolerance = Math.abs(d.yieldFactor - best) <= (CONFIDENCE_AGREEMENT_TOLERANCE * best);
        return sum + (withinTolerance ? d.weight : 0);
      }, 0);
      trainingConfidence[idx] = (agreeingWeight / totalDayWeight) * 100;
    }

    newYieldFactors[idx] = best;
  });

  const updatedSlots = newYieldFactors.filter((y) => y !== null).length;

  // Smooth the curve to remove measurement noise and quantization steps - spatial smoothing
  // across adjacent slots, orthogonal to and complementary with the statistical confidence
  // weighting within a slot above.
  //
  // BUG FOUND AND FIXED (2026-08-15, real device data): a missing neighbor used to fall back
  // to the slot's OWN value ("prev = arr[i-1] ?? arr[i]"), which only happens at a genuine
  // day/night boundary (the first/last daylight slot of a run), never a data gap mid-curve.
  // That fallback still lets the boundary slot blend toward its one REAL neighbor while never
  // being pulled back from the missing side - so across 3 passes, part of the sunrise peak's
  // value systematically leaks into the (declining) slots after it, with nothing available to
  // leak the other way. Confirmed on a real device: the boundary slot lost 9-12% of its value
  // per run, entirely absorbed by the next few slots - visually reading as a "delayed"
  // sunrise ramp, and getting worse as the boundary value itself grows (the p75 change above
  // made this materially more visible, from ~9% loss to ~12%, though the underlying mechanism
  // predates it and was already present, just smaller). Fix: a slot at a true day/night
  // boundary keeps its raw computed value untouched - only blend a slot with two REAL
  // neighbors, never invent one.
  for (let pass = 0; pass < 3; pass += 1) {
    const smoothed = [...newYieldFactors];
    for (let i = 1; i < 95; i += 1) {
      if (newYieldFactors[i] === null) continue;
      const prev = newYieldFactors[i - 1];
      const next = newYieldFactors[i + 1];
      if (prev === null || next === null) continue;
      smoothed[i] = (prev * 0.25) + (newYieldFactors[i] * 0.5) + (next * 0.25);
    }
    if (newYieldFactors[0] !== null && newYieldFactors[1] !== null) {
      smoothed[0] = (newYieldFactors[0] * 0.75) + (newYieldFactors[1] * 0.25);
    }
    if (newYieldFactors[95] !== null && newYieldFactors[94] !== null) {
      smoothed[95] = (newYieldFactors[95] * 0.75) + (newYieldFactors[94] * 0.25);
    }
    for (let i = 0; i < 96; i += 1) newYieldFactors[i] = smoothed[i];
  }

  const log = updatedSlots === 0
    ? 'No updates derived from data - no slot samples available.'
    : `Aggregated confidence-weighted model. ${updatedSlots} slots updated. (Global limit: ${datasetMaxYF.toFixed(2)})`;

  return {
    yieldFactors: newYieldFactors,
    updated: updatedSlots > 0,
    limit: datasetMaxYF,
    trainingConfidence,
    log,
  };
};

const calculateForecast = ({
  forecastData,
  yieldFactors,
  timestamp = new Date(),
  timezone = 'UTC',
}) => {
  const t = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const now = new Date(t);

  // yieldFactors[] is trained and indexed by genuine UTC hour (see solar/device.js
  // updateLearning()), so it must always be read back with getUTCHours()/getUTCMinutes()
  // on a real UTC timestamp — never on a local-time-relabeled-as-UTC ("fake-local") value.
  const forecastRadiation = getInterpolatedRadiation(t, forecastData);
  const slotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = Math.round(forecastRadiation * yieldFactor);

  // Day Total Yield: iterate the local day using real UTC boundaries (DST-safe), matching
  // how forecastData (real UTC keys) and yieldFactors (real UTC hour) are actually indexed.
  let totalYield = 0;

  const dayStart = TimeHelpers.getLocalMidnightUTC(now, timezone);
  const dayEnd = TimeHelpers.getLocalMidnightUTC(new Date(dayStart.getTime() + 26 * 60 * 60 * 1000), timezone);

  for (let slotMs = dayStart.getTime(); slotMs < dayEnd.getTime(); slotMs += 15 * 60 * 1000) {
    const daySlotIndex = (new Date(slotMs).getUTCHours() * 4) + Math.floor(new Date(slotMs).getUTCMinutes() / 15);
    const rad = getInterpolatedRadiation(slotMs, forecastData);
    const yf = yieldFactors[daySlotIndex] !== undefined ? yieldFactors[daySlotIndex] : 0;
    const power = rad * yf;
    totalYield += (power * 0.25) / 1000;
  }

  return {
    expectedPower,
    totalYield: Number(totalYield.toFixed(2)),
  };
};

const getSunBounds = (dateObj, forecastData, timezone = 'UTC') => {
  // DST-safe real UTC midnight via TimeHelpers (two-pass correction)
  // forecastData keys are real UTC timestamps, so we need real UTC midnight here.
  const startOfDay = TimeHelpers.getLocalMidnightUTC(dateObj, timezone);
  const nextDayObj = new Date(startOfDay.getTime() + 26 * 60 * 60 * 1000); // +26h always lands in next local day
  const endOfDay = TimeHelpers.getLocalMidnightUTC(nextDayObj, timezone);

  const noon = new Date(startOfDay);
  noon.setHours(noon.getHours() + 12);

  const timestamps = Object.keys(forecastData)
    .map(Number)
    .filter((ts) => ts >= startOfDay.getTime() && ts < endOfDay.getTime() && forecastData[ts] > 0)
    .sort((a, b) => a - b);

  if (timestamps.length === 0) {
    const s = new Date(noon); s.setHours(s.getHours() - 9);
    const e = new Date(noon); e.setHours(e.getHours() + 9);
    return { start: s, end: e };
  }

  const start = new Date(timestamps[0]);
  start.setHours(start.getHours() - 1);

  const end = new Date(timestamps[timestamps.length - 1]);
  end.setHours(end.getHours() + 2);

  const diff = Math.max(noon - start, end - noon);
  return { start: new Date(noon.getTime() - diff), end: new Date(noon.getTime() + diff) };
};

// Blends this retrain's fresh aggregateYieldFactors() result against the model as it stood
// after the previous retrain (`previousYields` - no longer a continuously live-updated
// array now that live learning is gone, just last night's/last run's stored yieldFactors),
// damping night-to-night swings the same way EMA damps sample-to-sample ones.
const mergeYields = ({
  historicYields, previousYields, alpha = 0.7, limit = 0, peakPower = 0,
}) => {
  // Same physically-anchored backstop as aggregateYieldFactors()'s per-slot safety cap:
  // `limit` (the global weighted-p90 datasetMaxYF) is derived from the highest-POWER
  // samples, which for any non-flat array are typically midday - and midday is
  // systematically where yieldFactor is LOWEST (GHI itself peaks at midday, panel-plane/GHI
  // ratio does not). Using it as a flat ceiling here wrongly clamped every slot back down to
  // the midday value even after the per-slot cap had correctly let a higher sunrise/sunset
  // yieldFactor through - confirmed against a real device (2026-08-14): the per-slot fix
  // alone produced a correct, smoothly-declining ~76->3 sunrise curve, but this final merge
  // clamp flattened the whole thing back down to a single ~7.3 plateau. Loosen it the same
  // way: never below what the array's own known peak capacity permits even at the lowest
  // radiation this module still trusts as daylight (the 10 W/m2 floor used throughout this
  // file) - only ever rejects an implausible value, never a legitimate ramp-hour one.
  const physicalCeiling = peakPower > 0 ? (peakPower * 1.1) / 10 : 0;
  const effectiveLimit = Math.max(limit, physicalCeiling);

  const merged = [];
  let updatedSlots = 0;
  for (let i = 0; i < 96; i += 1) {
    const historic = historicYields[i];
    const previous = previousYields[i] || 0;
    let newYield;

    if (historic !== null && historic !== undefined && previous > 0) {
      // Both have data, merge them.
      newYield = (historic * alpha) + (previous * (1 - alpha));
    } else if (historic !== null && historic !== undefined) {
      // Only historic has data, use it.
      newYield = historic;
    } else {
      // No historic data. Keep the previous value.
      newYield = previous;
    }

    // Hard Cap: Enforce the Physical Limit.
    // This safely limits upwards drift and prevents an old, bloated previous model
    // from pulling the newly merged model above physical reality.
    if (effectiveLimit > 0 && newYield > effectiveLimit * 1.01) {
      newYield = effectiveLimit * 1.01;
    }

    if (Math.abs(newYield - previous) > 0.001) {
      updatedSlots += 1;
    }
    merged[i] = newYield !== null ? newYield : 0;
  }
  return {
    yieldFactors: merged,
    log: `Merged historic and previous models. Alpha=${alpha}. ${updatedSlots} slots updated.`,
  };
};

module.exports = {
  detectCurtailment,
  calculateSmoothedPower,
  extractSlotSamples,
  aggregateYieldFactors,
  getInterpolatedRadiation,
  calculateForecast,
  getSunBounds,
  mergeYields,
};
