'use strict';

const collectBatteryInfo = (devices) => devices
  .map((device) => ({
    id: device.getData().id,
    name: device.getName(),
    maxCharge: device.getSettings().chargePower,
    maxDischarge: device.getSettings().dischargePower,
    soc: device.soc,
    actualPower: device.getCapabilityValue('measure_watt_avg'), // Device is Charge(+)/Discharge(-)
    xomTargetPower: device.xomTargetPower,
  }))
  .filter((info) => Number.isFinite(info.actualPower))
  .filter((info) => Number.isFinite(info.soc));

const calculateStrategy = (batteryInfo, totalTarget, minLoad) => {
  // 1. Sort batteries by priority (SoC)
  // Discharge: Higher SoC = Better. Charge: Lower SoC = Better.
  const sortedInfo = [...batteryInfo];
  if (totalTarget < 0) { // Discharge
    sortedInfo.sort((a, b) => b.soc - a.soc);
  } else { // Charge
    sortedInfo.sort((a, b) => a.soc - b.soc);
  }

  let finalStrategy = null;

  // 2. Iterative loop: Try with N batteries, then N-1, etc.
  // We want to find the smallest number of batteries that can handle the load efficiently.
  for (let i = sortedInfo.length; i > 0; i -= 1) {
    const currentSubset = sortedInfo.slice(0, i);

    // Calculate stats for this subset
    const totalSubsetSoc = currentSubset.reduce((sum, b) => sum + b.soc, 0);
    const totalSubsetEmpty = currentSubset.reduce((sum, b) => sum + (100 - b.soc), 0);

    // Calculate Proportional Split for this subset
    const attempt = currentSubset.map((info) => {
      let fraction = 0;
      if (totalTarget < 0) {
        fraction = (totalSubsetSoc > 0) ? (info.soc / totalSubsetSoc) : 0;
      } else if (totalTarget > 0) {
        fraction = (totalSubsetEmpty > 0) ? ((100 - info.soc) / totalSubsetEmpty) : 0;
      }

      let target = totalTarget * fraction;

      // Set minimum and maximum targets
      target = Math.max(-info.maxDischarge, Math.min(info.maxCharge, target));

      return { ...info, target };
    });

    // Check if this subset covers the Total Target (within tolerance)
    const totalAttempted = attempt.reduce((sum, b) => sum + b.target, 0);
    const difference = Math.abs(totalTarget - totalAttempted);
    // Tolerance check (10W)
    if (difference < 10) {
      // Valid Strategy found. Map back to full array.
      const strategyMap = new Map(attempt.map((b) => [b.id, b]));

      finalStrategy = sortedInfo.map((info) => {
        const active = strategyMap.get(info.id);
        let target = 0;
        let fraction = 0;

        if (active) {
          target = active.target;
          // Apply minLoad hysteresis/cutoff
          if (Math.abs(target) < minLoad) target = 0;

          // Re-calculate fraction for reference (though not strictly needed for logic)
          if (totalTarget !== 0) fraction = target / totalTarget;
        }

        // Calculate power headroom
        let headroom = 0;
        if (totalTarget < 0) headroom = (info.soc > 0) ? (info.maxDischarge + target) : 0;
        if (totalTarget > 0) headroom = (info.soc < 100) ? (info.maxCharge - target) : 0;

        return {
          ...info,
          target,
          headroom,
          fraction,
        };
      });
      // Continue loop to see if we can use FEWER batteries
    }
  }

  // If no strategy found (e.g. total target exceeds ALL batteries), fallback to using ALL (first iteration logic would have run).
  // Actually, if i=length failed coverage, then we are overloaded.
  // In that case, we should just return the i=length attempt (max power).
  if (!finalStrategy) {
    // Recalculate for ALL
    const currentSubset = sortedInfo; // All
    const totalSubsetSoc = currentSubset.reduce((sum, b) => sum + b.soc, 0);
    const totalSubsetEmpty = currentSubset.reduce((sum, b) => sum + (100 - b.soc), 0);
    finalStrategy = sortedInfo.map((info) => {
      let fraction = 0;
      if (totalTarget < 0) {
        fraction = (totalSubsetSoc > 0) ? (info.soc / totalSubsetSoc) : 0;
      } else if (totalTarget > 0) {
        fraction = (totalSubsetEmpty > 0) ? ((100 - info.soc) / totalSubsetEmpty) : 0;
      }
      let target = totalTarget * fraction;
      target = Math.max(-info.maxDischarge, Math.min(info.maxCharge, target));
      if (Math.abs(target) < minLoad) target = 0;

      let headroom = 0;
      if (totalTarget < 0) headroom = (info.soc > 0) ? (info.maxDischarge + target) : 0;
      if (totalTarget > 0) headroom = (info.soc < 100) ? (info.maxCharge - target) : 0;

      return {
        ...info, target, headroom, fraction,
      };
    });
  }

  return finalStrategy;
};

const applyPowerChange = (info, rawDelta, directionSignal) => {
  let delta = rawDelta;

  // Clamp delta to headroom based on direction
  if (directionSignal > 0) { // Charging direction
    if (delta > info.headroom) delta = info.headroom;
  } else if (delta < -info.headroom) { // Discharging direction
    delta = -info.headroom;
  }

  return {
    ...info,
    target: info.target + delta,
    headroom: info.headroom - delta,
    appliedDelta: delta,
  };
};

const distributeRemainingPower = (strategy, totalTarget) => {
  const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
  let restDelta = totalTarget - totalStratTarget;

  if (Math.abs(restDelta) <= 10) return strategy;

  // Pass 1: Distribute proportionally over active batteries with headroom
  const activeBatsWithHeadroom = strategy.filter((info) => info.target && info.headroom);
  const totalHeadroom = activeBatsWithHeadroom.reduce((sum, currentValue) => sum + currentValue.headroom, 0);

  if (activeBatsWithHeadroom.length && totalHeadroom > 0) {
    const distributeDelta = restDelta; // Use fixed total for proportion
    strategy = strategy.map((info) => {
      // Check if this battery participates in this pass
      if (!info.headroom || !info.target || (Math.abs(restDelta) < 10)) return info;

      const proportionalShare = distributeDelta * (info.headroom / totalHeadroom);
      const result = applyPowerChange(info, proportionalShare, distributeDelta);

      restDelta -= result.appliedDelta;
      delete result.appliedDelta; // Clean up temp prop
      return result;
    });
  }

  // Pass 2: Distribute remaining (greedy) using Best SoC
  if (Math.abs(restDelta) > 10) {
    // Sort by SoC: Best SoC first
    if (restDelta < 0) { // Discharging
      strategy.sort((a, b) => b.soc - a.soc);
    } else { // Charging
      strategy.sort((a, b) => a.soc - b.soc);
    }

    strategy = strategy.map((info) => {
      if (!info.headroom || (Math.abs(restDelta) < 10)) return info;

      // Try to take all remaining delta
      const result = applyPowerChange(info, restDelta, restDelta);

      restDelta -= result.appliedDelta;
      delete result.appliedDelta;
      return result;
    });
  }

  return strategy;
};

// Main function to calculate NOM/XOM strategy
const getStrategy = ({
  devices, // array of Homey device objects
  cumulativePower, // current total home power usage
  x = 0, // target offset (XOM setting)
  minLoad = 50, // minimum load threshold
}) => {
  // Strategy: divide required power based on SoC ratio. Assume all batteries are used!
  const batteryInfo = collectBatteryInfo(devices);

  const totalBattpower = batteryInfo.reduce((sum, currentValue) => sum + currentValue.actualPower, 0);
  const totalTarget = totalBattpower - (cumulativePower - x);

  let strategy = calculateStrategy(batteryInfo, totalTarget, minLoad);
  strategy = distributeRemainingPower(strategy, totalTarget);

  return strategy;
};

module.exports = {
  getStrategy,
};
