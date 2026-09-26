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

// Car SoC between car reports: the last reported SoC plus what this charger delivered since,
// times the charge efficiency (grid kWh to battery kWh). Car apps may only report after a trip,
// so without this the SoC would stand still for a whole charging night. Pure: the state object
// is stored by the device.
//
// The efficiency is learned between car reports with charging but no driving in between (same
// odometer), once the SoC rose enough for integer SoC rounding not to dominate: a car reporting
// every 1% is measured over several reports. Without an odometer the default is kept: a trip
// could hide in any gap.

const DEFAULT_EFFICIENCY = 0.88;
const MIN_EFFICIENCY = 0.6;
const MAX_EFFICIENCY = 1.0;
const EFFICIENCY_ALPHA = 0.3;
// SoC rise (percentage points) needed for an efficiency sample: reported SoC is an integer.
const MIN_SAMPLE_SOC_DELTA = 8;

const createState = () => ({
  baseSoc: null, // % as last reported by the car (or set by hand)
  baseTm: null,
  baseKwh: null, // charger kWh counter at baseTm
  baseOdo: null,
  effAnchor: null, // {soc, kwh, odo}: start of the current efficiency measurement
  efficiency: DEFAULT_EFFICIENCY,
  efficiencySamples: 0,
});

const chargedSinceBase = (state, kwhCounter) => {
  if (typeof kwhCounter !== 'number' || typeof state.baseKwh !== 'number') return 0;
  // A counter that went back (meter reset, other source device): nothing known since base.
  return Math.max(0, kwhCounter - state.baseKwh);
};

/**
 * Current SoC estimate, or null before the first report.
 *
 * @param {object} state
 * @param {number|null} kwhCounter - charger kWh counter now
 * @param {number} capacityKwh
 * @param {number|null} [carLimit] - the car's own charge limit (%), if known
 */
const estimate = (state, kwhCounter, capacityKwh, carLimit = null) => {
  if (!state || typeof state.baseSoc !== 'number') return null;
  const added = capacityKwh > 0 ? ((chargedSinceBase(state, kwhCounter) * state.efficiency) / capacityKwh) * 100 : 0;
  // The car stops by itself at its own limit, or when full.
  const ceiling = Math.max(state.baseSoc, typeof carLimit === 'number' && carLimit > 0 ? Math.min(100, carLimit) : 100);
  return Math.min(ceiling, state.baseSoc + added);
};

/**
 * A fresh SoC from the car (or entered by hand). Rebases the estimate and, when possible,
 * learns the efficiency. Returns the new state and the efficiency sample used, if any.
 *
 * @param {object} state
 * @param {object} report
 * @param {number} report.soc
 * @param {number} report.tm
 * @param {number|null} report.kwhCounter
 * @param {number|null} [report.odo]
 * @param {number} capacityKwh
 */
const onReport = (state, report, capacityKwh) => {
  const next = { ...createState(), ...state };
  let sample = null;
  const kwh = typeof report.kwhCounter === 'number' ? report.kwhCounter : null;
  const odo = typeof report.odo === 'number' ? report.odo : null;
  const anchor = next.effAnchor;
  const anchorValid = anchor && odo !== null && kwh !== null && Math.abs(odo - anchor.odo) < 0.5
    && kwh >= anchor.kwh && report.soc >= anchor.soc;
  if (!anchorValid) {
    next.effAnchor = (odo !== null && kwh !== null) ? { soc: report.soc, kwh, odo } : null;
  } else if (report.soc - anchor.soc >= MIN_SAMPLE_SOC_DELTA && report.soc < 100 && capacityKwh > 0
    && kwh > anchor.kwh) {
    const eff = (((report.soc - anchor.soc) / 100) * capacityKwh) / (kwh - anchor.kwh);
    if (eff >= MIN_EFFICIENCY && eff <= MAX_EFFICIENCY) {
      sample = eff;
      next.efficiency = next.efficiencySamples === 0
        ? eff
        : next.efficiency * (1 - EFFICIENCY_ALPHA) + eff * EFFICIENCY_ALPHA;
      next.efficiencySamples += 1;
    }
    next.effAnchor = { soc: report.soc, kwh, odo };
  }
  next.baseSoc = report.soc;
  next.baseTm = report.tm;
  next.baseKwh = kwh;
  next.baseOdo = odo !== null ? odo : next.baseOdo;
  return { state: next, sample };
};

/**
 * The charger kWh counter went back (meter reset, other source device): continue from the last
 * estimate with the new counter as base. Not a car report, so the odometer base stays.
 *
 * @param {object} state
 * @param {number} kwhCounter
 * @param {number} lastEstimate - last SoC estimate before the counter went back
 */
const rebaseCounter = (state, kwhCounter, lastEstimate) => ({
  ...state,
  effAnchor: null,
  baseSoc: typeof lastEstimate === 'number' ? lastEstimate : state.baseSoc,
  baseKwh: kwhCounter,
});

/**
 * True when the counter went back since the base.
 */
const counterWentBack = (state, kwhCounter) => typeof kwhCounter === 'number'
  && typeof state.baseKwh === 'number' && kwhCounter < state.baseKwh - 0.01;

module.exports = {
  createState,
  estimate,
  onReport,
  rebaseCounter,
  counterWentBack,
  chargedSinceBase,
  DEFAULT_EFFICIENCY,
  MIN_SAMPLE_SOC_DELTA,
};
