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

  // Support up to full 48-hour future price horizon before compression
  const intervalsPerHour = 60 / priceInterval;
  const maxInputSlots = Math.ceil(48 * intervalsPerHour);
  const calcPrices = prices.slice(0, maxInputSlots);
  const calcExportPrices = (exportPrices && exportPrices.length > 0) ? exportPrices.slice(0, maxInputSlots) : calcPrices;

  // 1. Zero-Delta Early Exit:
  // If battery is empty (startSoC == 0) and the maximum possible price spread (maxExport - minBuy) is strictly
  // less than minPriceDelta, no charge/discharge cycle can ever break even.
  const minBuyPrice = Math.min(...calcPrices);
  const maxExportPrice = Math.max(...calcExportPrices);
  const meanPrice = calcPrices.reduce((a, b) => a + b, 0) / calcPrices.length;

  const maxChargeEff = Math.max(...chargeSpeeds.map((s) => s.eff));
  const maxDischargeEff = Math.max(...dischargeSpeeds.map((s) => s.eff));

  // Terminal Salvage Value: expected value per kWh stored at the end of the horizon
  // based on average price, discharge efficiency, and write-off costs
  const terminalValuePerKwh = Math.max(0, (meanPrice * maxDischargeEff) - fc);

  // 1. Zero-Delta Early Exit:
  // If battery is empty and the maximum price spread is less than minPriceDelta (and no terminal salvage advantage exists),
  // no trade can ever produce positive ROI.
  if (startSoC <= 0.0001 && (maxExportPrice - minBuyPrice) < minPriceDelta && (terminalValuePerKwh - (minBuyPrice / maxChargeEff)) < minPriceDelta) {
    const emptyStrategy = {};
    calcPrices.forEach((price, origIdx) => {
      emptyStrategy[origIdx] = {
        power: 0,
        duration: 0,
        soc: 0,
        price,
        exportPrice: calcExportPrices[origIdx] !== undefined ? calcExportPrices[origIdx] : price,
      };
    });
    return emptyStrategy;
  }

  // 2. Create initial intervals
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

  // 3. Exact Flat-Price Merging:
  // Merge consecutive adjacent intervals with identical or sub-millicent price differences (<= 0.0001 €).
  // This collapses flat sequences with 0 loss of accuracy. Skip t=0 to preserve startMinute duration precision.
  let m = 1;
  while (m < initialSteps.length - 1) {
    const s1 = initialSteps[m];
    const s2 = initialSteps[m + 1];
    if (Math.abs(s1.price - s2.price) <= 0.0001 && Math.abs(s1.exportPrice - s2.exportPrice) <= 0.0001) {
      const totalDur = s1.durationHours + s2.durationHours;
      s1.price = (s1.price * s1.durationHours + s2.price * s2.durationHours) / totalDur;
      s1.exportPrice = (s1.exportPrice * s1.durationHours + s2.exportPrice * s2.durationHours) / totalDur;
      s1.durationHours = totalDur;
      s1.originalIndices.push(...s2.originalIndices);
      initialSteps.splice(m + 1, 1);
    } else {
      m += 1;
    }
  }

  // 4. Dead-Zone Interval Merging (Direction-aware + Baseload + Terminal Value):
  // An interval t is in the "Dead Zone" if it cannot be a profitable buy (no future export price or terminal value is high enough)
  // AND cannot be a profitable sell (no past buy price was low enough, assuming no initial SoC to dump).
  const isDeadZone = (stepIdx) => {
    if (startSoC > 0.0001 && stepIdx < 12) return false;

    const currentPrice = initialSteps[stepIdx].price;
    const currentExportPrice = initialSteps[stepIdx].exportPrice;

    // Can be a profitable buy? Compare against all future export prices AND terminal salvage value
    let canBeBuy = (terminalValuePerKwh - (currentPrice / maxChargeEff)) >= minPriceDelta;
    if (!canBeBuy) {
      for (let j = stepIdx + 1; j < initialSteps.length; j += 1) {
        if ((initialSteps[j].exportPrice * maxDischargeEff) - (currentPrice / maxChargeEff) >= minPriceDelta) {
          canBeBuy = true;
          break;
        }
      }
    }
    if (canBeBuy) return false;

    // Can be a profitable sell? Compare export tariff OR self-consumption import price against past buys
    let canBeSell = false;
    const effectiveSellPrice = Math.max(currentExportPrice, currentPrice); // self-consumption saves import price
    for (let j = 0; j < stepIdx; j += 1) {
      if ((effectiveSellPrice * maxDischargeEff) - (initialSteps[j].price / maxChargeEff) >= minPriceDelta) {
        canBeSell = true;
        break;
      }
    }
    return !canBeSell;
  };

  let dz = 1;
  while (dz < initialSteps.length - 1) {
    if (isDeadZone(dz) && isDeadZone(dz + 1)) {
      const s1 = initialSteps[dz];
      const s2 = initialSteps[dz + 1];
      const totalDur = s1.durationHours + s2.durationHours;
      s1.price = (s1.price * s1.durationHours + s2.price * s2.durationHours) / totalDur;
      s1.exportPrice = (s1.exportPrice * s1.durationHours + s2.exportPrice * s2.durationHours) / totalDur;
      s1.durationHours = totalDur;
      s1.originalIndices.push(...s2.originalIndices);
      initialSteps.splice(dz + 1, 1);
    } else {
      dz += 1;
    }
  }

  // 5. Adaptive LP Step Cap (max 72 steps):
  // If still above 72 steps, merge adjacent steps with the smallest price differences.
  const MAX_LP_STEPS = 72;
  while (initialSteps.length > MAX_LP_STEPS) {
    let minDiff = Infinity;
    let mergeIdx = -1;
    for (let i = 1; i < initialSteps.length - 1; i += 1) {
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

  // 6. Directional Variable Pruning Analysis per Step:
  // Pre-calculate whether each step should instantiate charge and/or discharge variables
  const stepCanCharge = new Array(initialSteps.length);
  const stepCanDischarge = new Array(initialSteps.length);

  for (let t = 0; t < initialSteps.length; t += 1) {
    const currentPrice = initialSteps[t].price;
    const currentExportPrice = initialSteps[t].exportPrice;

    // Check charging viability: profitable vs any future export slot OR terminal value
    let canCharge = (terminalValuePerKwh - (currentPrice / maxChargeEff)) >= (minPriceDelta * 0.5);
    if (!canCharge) {
      for (let j = t + 1; j < initialSteps.length; j += 1) {
        if ((initialSteps[j].exportPrice * maxDischargeEff) - (currentPrice / maxChargeEff) >= (minPriceDelta * 0.5)) {
          canCharge = true;
          break;
        }
      }
    }
    stepCanCharge[t] = canCharge;

    // Check discharging viability: profitable vs any past buy slot OR initial SoC
    if (currentPrice <= 0 && currentExportPrice <= 0) {
      stepCanDischarge[t] = false; // Never discharge into negative or zero price
    } else if (startSoC > 0.0001 && t < 12) {
      stepCanDischarge[t] = true; // Can discharge initial stored energy
    } else {
      let canDischarge = false;
      const effectiveSellPrice = Math.max(currentExportPrice, currentPrice);
      for (let j = 0; j < t; j += 1) {
        if ((effectiveSellPrice * maxDischargeEff) - (initialSteps[j].price / maxChargeEff) >= (minPriceDelta * 0.5)) {
          canDischarge = true;
          break;
        }
      }
      stepCanDischarge[t] = canDischarge;
    }
  }

  // 7. Build Sparse LP Model
  const model = {
    optimize: 'totalCost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  const lastStepIdx = initialSteps.length - 1;

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
    if (t < lastStepIdx) {
      model.variables[`soc_${t}`][`bal_${t + 1}`] = -1; // - SoC_{t-1} for next period
    } else {
      // Terminal Salvage Value: reward remaining energy at horizon end
      model.variables[`soc_${t}`].totalCost = -Math.round(terminalValuePerKwh * 10000) / 10000;
    }

    // Unidirectional Pruned Charge Variables
    if (stepCanCharge[t]) {
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
    }

    // Unidirectional Pruned Discharge Variables
    if (stepCanDischarge[t]) {
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
    }
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
