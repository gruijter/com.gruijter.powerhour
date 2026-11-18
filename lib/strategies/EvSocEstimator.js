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

const DEFAULT_EFFICIENCY = 0.88;
const MIN_EFFICIENCY = 0.6;
const MAX_EFFICIENCY = 1.0;
const EFFICIENCY_ALPHA = 0.3;
const MIN_SAMPLE_SOC_DELTA = 8;
const STALE_DROP_PCT = 2;

const createState = () => ({
  baseSoc: null,
  baseTm: null,
  baseKwh: null,
  baseOdo: null,
  effAnchor: null,
  efficiency: DEFAULT_EFFICIENCY,
  efficiencySamples: 0,
  ignoredTm: null,
  ignoredSoc: null,
});

const chargedSinceBase = (state, kwhCounter) => {
  if (typeof kwhCounter !== 'number' || typeof state.baseKwh !== 'number') return 0;
  return Math.max(0, kwhCounter - state.baseKwh);
};

const estimate = (state, kwhCounter, capacityKwh, carLimit = null) => {
  if (!state || typeof state.baseSoc !== 'number') return null;
  const added = capacityKwh > 0 ? ((chargedSinceBase(state, kwhCounter) * state.efficiency) / capacityKwh) * 100 : 0;
  const ceiling = Math.max(state.baseSoc, typeof carLimit === 'number' && carLimit > 0 ? Math.min(100, carLimit) : 100);
  return Math.min(ceiling, state.baseSoc + added);
};

const onReport = (state, report, capacityKwh) => {
  const next = { ...createState(), ...state };
  let sample = null;
  const kwh = typeof report.kwhCounter === 'number' ? report.kwhCounter : null;
  const odo = typeof report.odo === 'number' ? report.odo : null;
  if (!report.v2x && odo !== null && typeof next.baseOdo === 'number' && Math.abs(odo - next.baseOdo) < 0.5
    && typeof next.baseSoc === 'number' && report.soc < next.baseSoc - STALE_DROP_PCT
    && chargedSinceBase(next, kwh) > 0.1) {
    const repeat = next.ignoredSoc === report.soc;
    next.ignoredTm = report.tm;
    next.ignoredSoc = report.soc;
    return {
      state: next, sample, ignored: true, repeat,
    };
  }
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
  next.baseOdo = odo;
  return { state: next, sample };
};

const rebaseCounter = (state, kwhCounter, lastEstimate) => ({
  ...state,
  effAnchor: null,
  baseSoc: typeof lastEstimate === 'number' ? lastEstimate : state.baseSoc,
  baseKwh: kwhCounter,
});

const counterWentBack = (state, kwhCounter) => typeof kwhCounter === 'number'
  && typeof state.baseKwh === 'number' && kwhCounter < state.baseKwh - 0.01;

const counterJumped = (state, kwhCounter, capacityKwh) => capacityKwh > 0
  && chargedSinceBase(state, kwhCounter) > capacityKwh / MIN_EFFICIENCY;

const socLess = (soc, kwh, capacityKwh) => (capacityKwh > 0
  ? Math.max(0, Math.round((soc - (kwh / capacityKwh) * 100) * 10) / 10) : soc);

module.exports = {
  createState,
  socLess,
  counterJumped,
  estimate,
  onReport,
  rebaseCounter,
  counterWentBack,
  chargedSinceBase,
  DEFAULT_EFFICIENCY,
  MIN_SAMPLE_SOC_DELTA,
};
