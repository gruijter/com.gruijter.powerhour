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
  feedbackPrices = null, // array of hourly feed-in prices. Falls back to prices if missing
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
  const calcFeedbackPrices = feedbackPrices ? feedbackPrices.slice(0, limit) : calcPrices;

  // 1. Create initial intervals
  const initialSteps = calcPrices.map((price, t) => {
    const feedbackPrice = calcFeedbackPrices[t];
    const timeLeftinPeriod = t !== 0 ? 1 : (priceInterval - (startMinute % priceInterval)) / priceInterval;
    return {
      price,
      feedbackPrice,
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
        + Math.abs(initialSteps[i].feedbackPrice - initialSteps[i + 1].feedbackPrice);
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
      feedbackPrice: (s1.feedbackPrice * s1.durationHours + s2.feedbackPrice * s2.durationHours) / totalDur,
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
    const { price, feedbackPrice } = step;

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
        chargeCostPerHour = pKW * feedbackPrice;
      } else {
        chargeCostPerHour = (-ehKW * feedbackPrice) + ((pKW + ehKW) * price);
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
        dischargeRevPerHour = pKW * feedbackPrice;
      } else if (pKW <= ehKW) {
        dischargeRevPerHour = pKW * price;
      } else {
        dischargeRevPerHour = (ehKW * price) + ((pKW - ehKW) * feedbackPrice);
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
        power, duration: durationMins, soc: SoCh, price: calcPrices[origIdx],
      };
    });
  });

  // compatibility with old hedge_strategy sell = >0 | hold = 0 | buy = <0
  // return strategy[0].power;

  // console.log(strategy);
  return strategy;
};

module.exports = {
  getStrategy,
};

// TEST
// const prices = [0.25, 0.32, 0.429, 0.32, 0.429];
// const prices = [0.25, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
// const prices = [0.16, 0.17, 0.16, 0.13, 0.12, 0.12, 0.12, 0.12, 0.11, 0.11, 0.12, 0.15, 0.16, 0.16, 0.12, 0.10, 0.07, 0.04, 0.02, 0.01, 0.01, 0.06, 0.08, 0.11, 0.16, 0.17, 0.17, 0.17, 0.16];
// const prices = [0.29, 0.28, 0.27, 0.27, 0.27, 0.29, 0.30, 0.33, 0.32, 0.28, 0.27, 0.21, 0.22, 0.22, 0.21, 0.23, 0.25, 0.27, 0.29, 0.29, 0.30, 0.29, 0.28, 0.27];
// const prices = [
// 0.4854, 0.2918, 0.2885,
// 0.2841,
// 0.2856, 0.2937, 0.325, 0.3515,
// 0.3459, 0.3206, 0.2977, 0.2833,
// 0.2699, 0.261728, 0.2611956,
// 0.2697382, 0.2958379,
// 0.3299599, 0.4283329,
// 0.4895831, 0.5087132,
// 0.44683379999999995, 0.3645901,
// 0.3232686,

//   0.31740009999999996,
// 0.30666740000000003, 0.2983184,
// 0.28619419999999995, 0.2718799,
// 0.2704279, 0.2886989,
// 0.32415190000000005, 0.3211632,
// 0.3151616, 0.2767199,
// 0.2807613, 0.2765747,
// 0.2787164, 0.2905139,
// 0.2961646, 0.3052517,
// 0.3467426, 0.41173170000000003,
// 0.4762005, 0.45746970000000003,
// 0.38278850000000003, 0.3484245,
// 0.3130078,
// ];

// console.dir(getStrategy({ prices, soc: 50, startMinute: 25 }), { depth: null });

/*
{
  '0': { power: 1700, duration: 35, soc: 30, price: 0.4854 },
  '1': { power: 0, duration: 0, soc: 30, price: 0.2918 },
  '2': { power: 0, duration: 0, soc: 30, price: 0.2885 },
  '3': { power: 0, duration: 0, soc: 30, price: 0.2841 },
  '4': { power: 0, duration: 0, soc: 30, price: 0.2856 },
  '5': { power: 0, duration: 0, soc: 30, price: 0.2937 },
  '6': { power: 0, duration: 0, soc: 30, price: 0.325 },
  '7': { power: 0, duration: 0, soc: 30, price: 0.3515 },
  '8': { power: 0, duration: 0, soc: 30, price: 0.3459 },
  '9': { power: 0, duration: 0, soc: 30, price: 0.3206 },
  '10': { power: 0, duration: 0, soc: 30, price: 0.2977 },
  '11': { power: 0, duration: 0, soc: 30, price: 0.2833 },
  '12': { power: -1050, duration: 32, soc: 41, price: 0.2699 },
  '13': { power: -1050, duration: 60, soc: 60, price: 0.261728 },
  '14': { power: -1050, duration: 60, soc: 80, price: 0.2611956 },
  '15': { power: -1050, duration: 60, soc: 100, price: 0.2697382 },
  '16': { power: 0, duration: 0, soc: 100, price: 0.2958379 },
  '17': { power: 0, duration: 0, soc: 100, price: 0.3299599 },
  '18': { power: 765, duration: 60, soc: 85, price: 0.4283329 },
  '19': { power: 1700, duration: 60, soc: 51, price: 0.4895831 },
  '20': { power: 1700, duration: 60, soc: 18, price: 0.5087132 },
  '21': { power: 885, duration: 60, soc: 0, price: 0.44683379999999995 },
  '22': { power: 0, duration: 0, soc: 0, price: 0.3645901 },
  '23': { power: 0, duration: 0, soc: 0, price: 0.3232686 },
  '24': { power: 0, duration: 0, soc: 0, price: 0.31740009999999996 },
  '25': { power: 0, duration: 0, soc: 0, price: 0.30666740000000003 },
  '26': { power: 0, duration: 0, soc: 0, price: 0.2983184 },
  '27': { power: 0, duration: 0, soc: 0, price: 0.28619419999999995 },
  '28': { power: -1050, duration: 60, soc: 20, price: 0.2718799 },
  '29': { power: -1050, duration: 60, soc: 40, price: 0.2704279 },
  '30': { power: 0, duration: 0, soc: 40, price: 0.2886989 },
  '31': { power: 0, duration: 0, soc: 40, price: 0.32415190000000005 },
  '32': { power: 0, duration: 0, soc: 40, price: 0.3211632 },
  '33': { power: 0, duration: 0, soc: 40, price: 0.3151616 },
  '34': { power: -1050, duration: 60, soc: 59, price: 0.2767199 },
  '35': { power: 0, duration: 0, soc: 59, price: 0.2807613 },
  '36': { power: -1050, duration: 60, soc: 79, price: 0.2765747 },
  '37': { power: -1050, duration: 11, soc: 82, price: 0.2787164 },
  '38': { power: 0, duration: 0, soc: 82, price: 0.2905139 },
  '39': { power: 0, duration: 0, soc: 82, price: 0.2961646 },
  '40': { power: 0, duration: 0, soc: 82, price: 0.3052517 },
  '41': { power: 0, duration: 0, soc: 82, price: 0.3467426 },
  '42': { power: 765, duration: 60, soc: 67, price: 0.41173170000000003 },
  '43': { power: 1700, duration: 60, soc: 34, price: 0.4762005 },
  '44': { power: 1700, duration: 60, soc: 0, price: 0.45746970000000003 },
  '45': { power: 0, duration: 0, soc: 0, price: 0.38278850000000003 },
  '46': { power: 0, duration: 0, soc: 0, price: 0.3484245 },
  '47': { power: 0, duration: 0, soc: 0, price: 0.3130078 }
}
*/
