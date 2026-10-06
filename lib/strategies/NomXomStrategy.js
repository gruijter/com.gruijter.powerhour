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

const collectBatteryInfo = (devices) => devices
  .map((device) => ({
    id: device.getData().id,
    name: device.getName(),
    maxCharge: Number(device.getSettings().chargePower) || 2000,
    maxDischarge: Number(device.getSettings().dischargePower) || 2000,
    effCharge: Number(device.getSettings().chargePowerEff) || Number(device.getSettings().chargePower) || 2000,
    effDischarge: Number(device.getSettings().dischargePowerEff) || Number(device.getSettings().dischargePower) || 2000,
    soc: Math.max(0, Math.min(100, device.soc)),
    actualPower: device.getCapabilityValue('measure_watt_avg') || 0, // charge (+) / discharge (-)
    xomTargetPower: device.xomTargetPower || 0,
  }))
  .filter((info) => Number.isFinite(info.soc));

/**
 * Power distribution across batteries: the smallest subset that can handle the load, prioritized
 * by SoC with hysteresis.
 */
const calculateStrategy = (batteryInfo, totalTarget, minLoad) => {
  // 1. Priority by SoC (discharge: higher first, charge: lower first), with a bonus for a battery
  // already doing what we want.
  const sortedInfo = [...batteryInfo];
  const hysteresis = 20; // % SoC, against flip-flopping
  const activeBatteriesCount = batteryInfo.filter((b) => Math.abs(b.xomTargetPower) > 10).length;
  const efficiencyHysteresis = 1.1; // 10% efficiency hysteresis

  if (totalTarget < 0) { // Discharge
    sortedInfo.sort((a, b) => {
      const scoreA = a.soc + (a.xomTargetPower < -10 ? hysteresis : 0);
      const scoreB = b.soc + (b.xomTargetPower < -10 ? hysteresis : 0);
      return scoreB - scoreA;
    });
  } else { // Charge
    sortedInfo.sort((a, b) => {
      const scoreA = a.soc - (a.xomTargetPower > 10 ? hysteresis : 0);
      const scoreB = b.soc - (b.xomTargetPower > 10 ? hysteresis : 0);
      return scoreA - scoreB;
    });
  }

  let finalStrategy = null;

  // 2. Try 1 battery, then 2, etc.
  for (let i = 1; i <= sortedInfo.length; i += 1) {
    const currentSubset = sortedInfo.slice(0, i);

    // Efficiency hysteresis when swapping, or when using a superset of the active batteries
    const activeInSubsetCount = currentSubset.filter((b) => Math.abs(b.xomTargetPower) > 10).length;
    const allowHysteresis = (currentSubset.length === activeBatteriesCount) || (activeInSubsetCount === activeBatteriesCount);

    const totalSubsetSoc = currentSubset.reduce((sum, b) => sum + Math.max(b.soc, 0.1), 0);
    const totalSubsetEmpty = currentSubset.reduce((sum, b) => sum + Math.max(100 - b.soc, 0.1), 0);

    // Split weighted by SoC (or headroom for charging)
    const attempt = currentSubset.map((info) => {
      let fraction = 0;
      if (totalTarget < 0) {
        fraction = Math.max(info.soc, 0.1) / totalSubsetSoc;
      } else if (totalTarget > 0) {
        fraction = Math.max(100 - info.soc, 0.1) / totalSubsetEmpty;
      }

      let target = totalTarget * fraction;
      target = Math.max(-info.maxDischarge, Math.min(info.maxCharge, target));

      return { ...info, target };
    });

    const totalAttempted = attempt.reduce((sum, b) => sum + b.target, 0);
    const difference = Math.abs(totalTarget - totalAttempted);
    // 10 W tolerance
    if (difference < 10) {
      // Prefer more batteries above their efficient power
      const isEfficient = attempt.every((b) => {
        const limitCharge = b.effCharge * (allowHysteresis ? efficiencyHysteresis : 1.0);
        const limitDischarge = b.effDischarge * (allowHysteresis ? efficiencyHysteresis : 1.0);

        if (b.target > 0.1) return b.target <= limitCharge;
        if (b.target < -0.1) return Math.abs(b.target) <= limitDischarge;
        return true;
      });

      const strategyMap = new Map(attempt.map((b) => [b.id, b]));

      const currentStrategy = sortedInfo.map((info) => {
        const active = strategyMap.get(info.id);
        let target = 0;
        let fraction = 0;

        if (active) {
          target = active.target;
          // minLoad cutoff, only when the total target is small too
          if (Math.abs(target) < minLoad && Math.abs(totalTarget) < minLoad) target = 0;

          if (totalTarget !== 0) fraction = target / totalTarget;
        }

        // Headroom: how much more can be charged / discharged (target is signed)
        const headroomCharge = Math.max(0, info.maxCharge - target);
        const headroomDischarge = Math.max(0, info.maxDischarge + target);

        return {
          ...info,
          target,
          headroomCharge,
          headroomDischarge,
          fraction,
        };
      });

      if (isEfficient) {
        finalStrategy = currentStrategy;
        break;
      }
      if (!finalStrategy) finalStrategy = currentStrategy;
    }
  }

  // No subset meets the target: split proportionally across all.
  if (!finalStrategy) {
    const currentSubset = sortedInfo;
    const totalSubsetSoc = currentSubset.reduce((sum, b) => sum + Math.max(b.soc, 0.1), 0);
    const totalSubsetEmpty = currentSubset.reduce((sum, b) => sum + Math.max(100 - b.soc, 0.1), 0);
    finalStrategy = sortedInfo.map((info) => {
      let fraction = 0;
      if (totalTarget < 0) {
        fraction = Math.max(info.soc, 0.1) / totalSubsetSoc;
      } else if (totalTarget > 0) {
        fraction = Math.max(100 - info.soc, 0.1) / totalSubsetEmpty;
      }
      let target = totalTarget * fraction;
      target = Math.max(-info.maxDischarge, Math.min(info.maxCharge, target));
      if (Math.abs(target) < minLoad && Math.abs(totalTarget) < minLoad) target = 0;

      const headroomCharge = Math.max(0, info.maxCharge - target);
      const headroomDischarge = Math.max(0, info.maxDischarge + target);

      return {
        ...info, target, headroomCharge, headroomDischarge, fraction,
      };
    });
  }

  return finalStrategy;
};

/**
 * Helper to apply a power delta to a battery's target, respecting its headroom.
 * @param {object} info - Battery info object
 * @param {number} rawDelta - The amount of power to try and add/remove
 * @param {number} directionSignal - The direction of the overall distribution (positive = charge)
 */
const applyPowerChange = (info, rawDelta, directionSignal) => {
  let delta = rawDelta;

  if (directionSignal > 0) {
    if (delta > info.headroomCharge) delta = info.headroomCharge;
  } else if (delta < -info.headroomDischarge) {
    delta = -info.headroomDischarge;
  }

  const newTarget = info.target + delta;
  const headroomCharge = Math.max(0, info.maxCharge - newTarget);
  const headroomDischarge = Math.max(0, info.maxDischarge + newTarget);

  return {
    ...info,
    target: newTarget,
    headroomCharge,
    headroomDischarge,
    appliedDelta: delta,
  };
};

/**
 * Distributes target power the initial strategy did not cover: proportional first, then greedy.
 */
const distributeRemainingPower = (strategy, totalTarget, minLoad) => {
  const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
  let restDelta = totalTarget - totalStratTarget;

  if (Math.abs(restDelta) <= 10) return strategy;

  const newStrategy = strategy.map((s) => ({ ...s }));

  // Pass 1: proportional over active batteries with headroom
  const isCharging = restDelta > 0;

  const activeBatsWithHeadroom = newStrategy.filter((info) => {
    if (!info.target) return false;
    return isCharging ? (info.headroomCharge > 0) : (info.headroomDischarge > 0);
  });

  const totalHeadroom = activeBatsWithHeadroom.reduce((sum, info) => sum + (isCharging ? info.headroomCharge : info.headroomDischarge), 0);

  if (activeBatsWithHeadroom.length && totalHeadroom > 0) {
    const distributeDelta = restDelta;
    for (let i = 0; i < newStrategy.length; i += 1) {
      const info = newStrategy[i];
      if (!info.target) continue;
      const h = isCharging ? info.headroomCharge : info.headroomDischarge;
      if (h <= 0) continue;

      if (Math.abs(restDelta) < 10) break;

      const proportionalShare = distributeDelta * (h / totalHeadroom);
      const { appliedDelta, ...updatedInfo } = applyPowerChange(info, proportionalShare, distributeDelta);

      restDelta -= appliedDelta;
      newStrategy[i] = updatedInfo;
    }
  }

  // Pass 2: greedy, best SoC first
  if (Math.abs(restDelta) > 10) {
    if (restDelta < 0) { // Discharging
      newStrategy.sort((a, b) => b.soc - a.soc);
    } else { // Charging
      newStrategy.sort((a, b) => a.soc - b.soc);
    }

    for (let i = 0; i < newStrategy.length; i += 1) {
      const info = newStrategy[i];
      const h = (restDelta > 0) ? info.headroomCharge : info.headroomDischarge;
      if (h <= 0) continue;

      if (Math.abs(restDelta) < 10) break;

      // An idle battery is only activated when the rest is large enough.
      if (info.target === 0 && Math.abs(restDelta) < minLoad) {
        break;
      }

      const { appliedDelta, ...updatedInfo } = applyPowerChange(info, restDelta, restDelta);

      restDelta -= appliedDelta;
      newStrategy[i] = updatedInfo;
    }
  }

  return newStrategy;
};

/**
 * NOM/XOM strategy: balances a power target across battery devices.
 * @param {object} params
 * @param {Array} params.devices - Homey device objects
 * @param {number} params.cumulativePower - current total home power
 * @param {number} [params.x=0] - target offset (XOM setting)
 * @param {number} [params.minLoad=50] - minimum load threshold
 */
const getStrategy = ({
  devices,
  cumulativePower,
  x = 0,
  minLoad = 50,
}) => {
  const batteryInfo = collectBatteryInfo(devices);
  if (!batteryInfo || batteryInfo.length === 0) return [];

  // From the last commands, not actualPower: that would break the integral loop (anti-windup).
  const totalBattpower = batteryInfo.reduce((sum, info) => sum + (info.xomTargetPower || 0), 0);
  const safeX = Number(x) || 0;
  const safeMinLoad = Number.isFinite(Number(minLoad)) ? Number(minLoad) : 50;

  const totalTarget = totalBattpower - (cumulativePower - safeX);

  // 1. Early exit: target within tolerance, or at a capacity boundary
  const allFull = batteryInfo.every((b) => b.soc >= 99.9);
  const allEmpty = batteryInfo.every((b) => b.soc <= 0.1);

  if (Math.abs(totalTarget) < 10 || (totalTarget > 0 && allFull) || (totalTarget < 0 && allEmpty)) {
    return batteryInfo.map((info) => ({
      ...info,
      target: 0,
      headroomCharge: info.maxCharge,
      headroomDischarge: info.maxDischarge,
      fraction: 0,
    }));
  }

  let strategy = calculateStrategy(batteryInfo, totalTarget, safeMinLoad);
  strategy = distributeRemainingPower(strategy, totalTarget, safeMinLoad);

  // All batteries follow the main direction
  strategy = strategy.map((s) => {
    if (totalTarget > 0 && s.target < 0) return { ...s, target: 0 };
    if (totalTarget < 0 && s.target > 0) return { ...s, target: 0 };
    return s;
  });

  return strategy;
};

module.exports = {
  getStrategy,
};
