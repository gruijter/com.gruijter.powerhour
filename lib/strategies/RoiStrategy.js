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

const solver = require('javascript-lp-solver');

// returns the best trading strategy for all known coming hours
const getStrategy = ({
  prices, // array of hourly prices, e.g. [0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
  exportPrices = null, // array of hourly feed-in prices. Falls back to prices if missing
  priceInterval = 60, // price interval in minutes
  minPriceDelta = 0.1, // mimimum price difference to sell/buy. Should include 2x fixed costs per kWh for break even.
  soc = 0, // Battery State of Charge at start of first hour in %
  startMinute = 0, // minute of the first hour to start the calculation
  batCapacity = 5.05, // kWh, defaults to Sessy value
  homePowerUsage = 300, // Fixed in-house power usage in Watts
  chargeSpeeds = [// defaults to Sessy values
    {
      power: 2200, // Watt. Max speed charging power in Watt (on AC side), loss is included
      eff: 0.9, // efficiency when using Max speed charging
    },
    {
      power: 1050, // Watt. Efficient charging power in Watt (on AC side), loss is included
      eff: 0.95, // efficiency when using Efficient charging
    },
  ],
  dischargeSpeeds = [// defaults to Sessy values
    {
      power: 1550, // Max speed discharging power in Watt (on DC side!), loss is not included
      eff: 0.92, // efficiency when using Max speed discharging
    },
    {
      power: 765, // Efficient discharging power in Watt. (on DC side!), loss is not included
      eff: 0.96, // efficiency when using Efficient discharging
    },
  ],
  cleanUpStrategy = true,
}) => {
  const fc = minPriceDelta * 0.5; // fixed cost per kW charging or discharging, e.g. for system write off
  const startSoC = Math.round((soc / 100) * batCapacity * 10000) / 10000; // kWh (when 0, the battery is empty at start)
  const minDuration = Math.max(1, Math.round(priceInterval / 6));

  // Limit optimization horizon to prevent memory issues/crashes
  const intervalsPerHour = 60 / priceInterval;
  const maxIntervals = 96; // Project 24h at 15m, 48h at 30m/60m
  const horizonHours = Math.min(48, maxIntervals / intervalsPerHour);
  const limit = Math.ceil(horizonHours * intervalsPerHour);
  const calcPrices = prices.slice(0, limit);
  const calcExportPrices = (exportPrices && exportPrices.length > 0) ? exportPrices.slice(0, limit) : calcPrices;

  // 1. Create initial intervals
  const initialSteps = calcPrices.map((price, t) => {
    const exportPrice = calcExportPrices[t] !== undefined ? calcExportPrices[t] : price;
    const timeLeftinPeriod = t !== 0 ? 1 : (priceInterval - (startMinute % priceInterval)) / priceInterval;
    return {
      price,
      exportPrice,
      durationHours: timeLeftinPeriod * (priceInterval / 60),
      originalIndices: [t],
    };
  });

  // 2. Pre-process: Adaptive merging of adjacent intervals with smallest price differences.
  // This compresses the LP Simplex matrix strictly to a safe size without losing peak/trough accuracy.
  const MAX_LP_STEPS = 64;
  while (initialSteps.length > MAX_LP_STEPS) {
    let minDiff = Infinity;
    let mergeIdx = -1;
    for (let i = 1; i < initialSteps.length - 1; i += 1) { // Skip index 0 to retain exact execution precision
      const diff = Math.abs(initialSteps[i].price - initialSteps[i + 1].price)
        + Math.abs(initialSteps[i].exportPrice - initialSteps[i + 1].exportPrice);
      if (diff < minDiff) {
        minDiff = diff;
        mergeIdx = i;
      }
    }
    const s1 = initialSteps[mergeIdx];
    const s2 = initialSteps[mergeIdx + 1];
    const totalDur = s1.durationHours + s2.durationHours;
    const mergedStep = {
      price: (s1.price * s1.durationHours + s2.price * s2.durationHours) / totalDur,
      exportPrice: (s1.exportPrice * s1.durationHours + s2.exportPrice * s2.durationHours) / totalDur,
      durationHours: totalDur,
      originalIndices: [...s1.originalIndices, ...s2.originalIndices],
    };
    initialSteps.splice(mergeIdx, 2, mergedStep);
  }

  const model = {
    optimize: 'totalCost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  // Build sparse model
  initialSteps.forEach((step, t) => {
    const { price, exportPrice } = step;

    // 1. Time constraint: Max 1.0 (100% of this chunk's duration)
    model.constraints[`time_${t}`] = { max: 1 };

    // 2. Balance constraint: SoC_t - SoC_{t-1} - Charge + Discharge = 0
    // For t=0: SoC_0 - Charge + Discharge = StartSoC
    model.constraints[`bal_${t}`] = { equal: (t === 0 ? startSoC : 0) };

    // 3. Capacity constraint: 0 <= SoC_t <= Capacity
    model.constraints[`cap_${t}`] = { min: 0, max: batCapacity };

    // --- Variables ---

    // SoC State Variable (at end of period t)
    model.variables[`soc_${t}`] = {
      [`bal_${t}`]: 1, // SoC_t
      [`cap_${t}`]: 1, // Check bounds
    };
    if (t < initialSteps.length - 1) {
      model.variables[`soc_${t}`][`bal_${t + 1}`] = -1; // - SoC_{t-1} for next period
    }

    // Charge Variables
    [...chargeSpeeds].forEach((speed, idx) => {
      const varName = `cs${idx}T${t}`;
      const pKW = speed.power / 1000;
      const ehKW = homePowerUsage / 1000;

      let chargeCostPerHour = 0;
      if (ehKW >= 0) {
        chargeCostPerHour = pKW * price;
      } else if (pKW <= -ehKW) {
        chargeCostPerHour = pKW * exportPrice;
      } else {
        chargeCostPerHour = (-ehKW * exportPrice) + ((pKW + ehKW) * price);
      }

      const energyBat = pKW * step.durationHours * speed.eff; // Energy added to battery
      const cost = (chargeCostPerHour + pKW * fc) * step.durationHours;

      model.variables[varName] = {
        totalCost: Math.round(cost * 10000) / 10000,
        [`time_${t}`]: 1,
        [`bal_${t}`]: -Math.round(energyBat * 10000) / 10000, // Moves to RHS as +energy
      };
    });

    // Discharge Variables
    [...dischargeSpeeds].forEach((speed, idx) => {
      const varName = `ds${idx}T${t}`;
      const pKW = speed.power / 1000;
      const ehKW = homePowerUsage / 1000;

      let dischargeRevPerHour = 0;
      if (ehKW <= 0) {
        dischargeRevPerHour = pKW * exportPrice;
      } else if (pKW <= ehKW) {
        dischargeRevPerHour = pKW * price;
      } else {
        dischargeRevPerHour = (ehKW * price) + ((pKW - ehKW) * exportPrice);
      }

      const energyBat = (pKW * step.durationHours) / speed.eff; // Energy removed from battery
      const cost = -(dischargeRevPerHour - pKW * fc) * step.durationHours; // Revenue is negative cost

      model.variables[varName] = {
        totalCost: Math.round(cost * 10000) / 10000,
        [`time_${t}`]: 1,
        [`bal_${t}`]: Math.round(energyBat * 10000) / 10000, // Moves to RHS as -energy
      };
    });
  });

  const solved = solver.Solve(model);

  // Create summarized strategy output.
  const strategy = {};
  let storedEnergy = startSoC;
  let lastPower = 0;

  initialSteps.forEach((step, t) => {
    const stratResultKeys = Object.keys(solved)
      .filter((key) => key.endsWith(`T${t}`));

    let totalTimeFrac = 0;
    let avgPower = 0;
    let stepEnergyChange = 0;

    stratResultKeys.forEach((stratKey) => {
      const fraction = solved[stratKey];
      if (!fraction) return;

      if (stratKey.includes('cs')) { // is a charging factor
        const chrgIndex = stratKey[2]; // third character of key name
        const chrgPower = chargeSpeeds[chrgIndex].power / 1000;
        totalTimeFrac += fraction;
        avgPower += fraction * chrgPower; // charging power is positive
        stepEnergyChange += (fraction * chrgPower * chargeSpeeds[chrgIndex].eff) * step.durationHours;
      }
      if (stratKey.includes('ds')) { // is a discharging factor
        const dchrgIndex = stratKey[2]; // third character of key name
        const dchrgPower = dischargeSpeeds[dchrgIndex].power / 1000;
        totalTimeFrac += fraction;
        avgPower -= fraction * dchrgPower; // discharging power is negative
        stepEnergyChange -= ((fraction * dchrgPower) / dischargeSpeeds[dchrgIndex].eff) * step.durationHours;
      }
    });

    const rawPower = totalTimeFrac > 0 ? Math.round((avgPower * 1000) / totalTimeFrac) : 0;

    // Distribute results back into the original intervals expected by the flows & charts
    step.originalIndices.forEach((origIdx) => {
      const isFirst = origIdx === 0;
      const origDurMins = isFirst ? (priceInterval - (startMinute % priceInterval)) : priceInterval;
      const origDurHours = origDurMins / 60;

      let durationMins = Math.round(totalTimeFrac * origDurMins);
      let power = rawPower;

      const subEnergyChange = stepEnergyChange * (origDurHours / step.durationHours);
      storedEnergy += subEnergyChange;
      let SoCh = Math.max(Math.round(100 * (storedEnergy / batCapacity)), 0);

      if (cleanUpStrategy) {
        if (((durationMins < minDuration) && (power > 0) && (SoCh < 95) && lastPower <= 0)
          || ((durationMins < minDuration) && (power < 0) && (SoCh > 5) && lastPower >= 0)) {
          power = 0;
          durationMins = 0;
          storedEnergy -= subEnergyChange;
          SoCh = Math.abs(Math.round(100 * (storedEnergy / batCapacity)));
        }
        if (((durationMins < origDurMins) && (power > 0) && (SoCh > 97))
          || ((durationMins < origDurMins) && (power < 0) && (SoCh < 3))) {
          durationMins = origDurMins;
        }
      }

      lastPower = power;
      strategy[origIdx] = {
        power, duration: durationMins, soc: SoCh, price: calcPrices[origIdx], exportPrice: calcExportPrices[origIdx] !== undefined ? calcExportPrices[origIdx] : calcPrices[origIdx],
      };
    });
  });

  return strategy;
};

module.exports = {
  getStrategy,
};
