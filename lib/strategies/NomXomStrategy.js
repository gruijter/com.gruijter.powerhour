'use strict';

const collectBatteryInfo = (devices) => devices
  .map((device) => ({
    id: device.getData().id,
    name: device.getName(),
    maxCharge: Number(device.getSettings().chargePower) || 2000,
    maxDischarge: Number(device.getSettings().dischargePower) || 2000,
    soc: device.soc,
    actualPower: device.getCapabilityValue('measure_watt_avg') || 0, // Device is Charge(+)/Discharge(-)
    xomTargetPower: device.xomTargetPower,
  }))
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
    if (difference < 10) { // This subset can handle the load
      // Valid Strategy found. Map back to full array.
      const strategyMap = new Map(attempt.map((b) => [b.id, b]));

      finalStrategy = sortedInfo.map((info) => {
        const active = strategyMap.get(info.id);
        let target = 0;
        let fraction = 0;

        if (active) {
          target = active.target;
          // Apply minLoad hysteresis/cutoff
          // Only apply minLoad if the total target is also small, otherwise we might get stuck
          if (Math.abs(target) < minLoad && Math.abs(totalTarget) < minLoad) target = 0;

          // Re-calculate fraction for reference (though not strictly needed for logic)
          if (totalTarget !== 0) fraction = target / totalTarget;
        }

        // Calculate power headroom
        // Headroom Charge: How much MORE we can charge (maxCharge - target)
        // Headroom Discharge: How much MORE we can discharge (maxDischarge + target) [assuming target is negative]
        // Note: target is signed.
        const headroomCharge = (info.soc < 100) ? Math.max(0, info.maxCharge - target) : 0;
        const headroomDischarge = (info.soc > 0) ? Math.max(0, info.maxDischarge + target) : 0;

        return {
          ...info,
          target,
          headroomCharge,
          headroomDischarge,
          fraction,
        };
      });
      // Stop looking for fewer batteries. We found a solution with 'i' batteries.
      // Since we iterate from N down to 1, this prioritizes using MORE batteries (Distribution).
      break;
    }
  }

  // If no strategy found (e.g. total target exceeds ALL batteries), fallback to using ALL (first iteration logic would have run).
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
      if (Math.abs(target) < minLoad && Math.abs(totalTarget) < minLoad) target = 0;

      const headroomCharge = (info.soc < 100) ? Math.max(0, info.maxCharge - target) : 0;
      const headroomDischarge = (info.soc > 0) ? Math.max(0, info.maxDischarge + target) : 0;

      return {
        ...info, target, headroomCharge, headroomDischarge, fraction,
      };
    });
  }

  return finalStrategy;
};

const applyPowerChange = (info, rawDelta, directionSignal) => {
  let delta = rawDelta;

  if (directionSignal > 0) { // Charging direction (Adding power)
    if (delta > info.headroomCharge) delta = info.headroomCharge;
  } else if (delta < -info.headroomDischarge) { // Discharging direction (Removing power / decreasing value)
    // delta is negative. Check against negative headroomDischarge
    delta = -info.headroomDischarge;
  }

  const newTarget = info.target + delta;
  // Recalculate headrooms for next pass
  const headroomCharge = (info.soc < 100) ? Math.max(0, info.maxCharge - newTarget) : 0;
  const headroomDischarge = (info.soc > 0) ? Math.max(0, info.maxDischarge + newTarget) : 0;

  return {
    ...info,
    target: newTarget,
    headroomCharge,
    headroomDischarge,
    appliedDelta: delta,
  };
};

const distributeRemainingPower = (strategy, totalTarget, minLoad) => {
  const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
  let restDelta = totalTarget - totalStratTarget;

  if (Math.abs(restDelta) <= 10) return strategy;

  const newStrategy = strategy.map((s) => ({ ...s })); // Work on a copy

  // Pass 1: Distribute proportionally over active batteries with headroom
  const isCharging = restDelta > 0;

  // Filter for active batteries that have relevant headroom
  const activeBatsWithHeadroom = newStrategy.filter((info) => {
    // Must be active (non-zero target) OR we can treat it as active if we really want,
    // but original logic filtered for 'info.target'. Keep this.
    if (!info.target) return false;
    return isCharging ? (info.headroomCharge > 0) : (info.headroomDischarge > 0);
  });

  const totalHeadroom = activeBatsWithHeadroom.reduce((sum, info) => sum + (isCharging ? info.headroomCharge : info.headroomDischarge), 0);

  if (activeBatsWithHeadroom.length && totalHeadroom > 0) {
    const distributeDelta = restDelta; // Use fixed total for proportion
    for (let i = 0; i < newStrategy.length; i += 1) {
      const info = newStrategy[i];
      // Check if this battery participates in this pass
      if (!info.target) continue;
      const h = isCharging ? info.headroomCharge : info.headroomDischarge;
      if (h <= 0) continue;

      if (Math.abs(restDelta) < 10) break;

      const proportionalShare = distributeDelta * (h / totalHeadroom);
      const result = applyPowerChange(info, proportionalShare, distributeDelta);

      restDelta -= result.appliedDelta;
      delete result.appliedDelta; // Clean up temp prop
      newStrategy[i] = result;
    }
  }

  // Pass 2: Distribute remaining (greedy) using Best SoC
  if (Math.abs(restDelta) > 10) {
    // Sort by SoC: Best SoC first
    if (restDelta < 0) { // Discharging
      newStrategy.sort((a, b) => b.soc - a.soc);
    } else { // Charging
      newStrategy.sort((a, b) => a.soc - b.soc);
    }

    for (let i = 0; i < newStrategy.length; i += 1) {
      const info = newStrategy[i];
      // Check relevant headroom
      const h = (restDelta > 0) ? info.headroomCharge : info.headroomDischarge;
      if (h <= 0) continue;

      if (Math.abs(restDelta) < 10) break;

      // If a battery is idle, we can only activate it if the remaining delta is large enough.
      if (info.target === 0 && Math.abs(restDelta) < minLoad) {
        break;
      }

      // Try to take all remaining delta
      const result = applyPowerChange(info, restDelta, restDelta);

      restDelta -= result.appliedDelta;
      delete result.appliedDelta;
      newStrategy[i] = result;
    }
  }

  return newStrategy;
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

  console.log('[NomXom] Batteries:', batteryInfo.map((b) => `${b.name} (SoC:${Math.round(b.soc)}% Act:${Math.round(b.actualPower)}W Tgt:${Math.round(b.xomTargetPower)}W)`).join(', '));

  // Calculate the total power we *think* the batteries are delivering based on the last command.
  // We do NOT use actualPower here, because that would break the integral control loop (anti-windup).
  const totalBattpower = batteryInfo.reduce((sum, info) => sum + (info.xomTargetPower || 0), 0);
  const totalTarget = totalBattpower - (cumulativePower - x);
  console.log(`[NomXom] TotalBattPower: ${Math.round(totalBattpower)}W | TotalTarget: ${Math.round(totalTarget)}W`);

  let strategy = calculateStrategy(batteryInfo, totalTarget, minLoad);
  strategy = distributeRemainingPower(strategy, totalTarget, minLoad);

  // Final safety check: ensure all batteries follow the main direction
  strategy = strategy.map((s) => {
    if (totalTarget > 0 && s.target < 0) return { ...s, target: 0 };
    if (totalTarget < 0 && s.target > 0) return { ...s, target: 0 };
    return s;
  });

  console.log('[NomXom] Strategy:', strategy.map((s) => `${s.name}: ${Math.round(s.target)}W`).join(', '));
  return strategy;
};

module.exports = {
  getStrategy,
};
