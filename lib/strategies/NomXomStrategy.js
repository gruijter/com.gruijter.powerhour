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

const calculateStrategy = (batteryInfo, totalTarget, totalBattSoc, totalEmptySpace, minLoad) => batteryInfo.map((info) => {
  let fraction = 0;
  let target = 0;

  if (totalTarget < 0) { // Discharge
    fraction = (totalBattSoc > 0) ? (info.soc / totalBattSoc) : 0;
  } else if (totalTarget > 0) { // Charge
    fraction = (totalEmptySpace > 0) ? ((100 - info.soc) / totalEmptySpace) : 0;
  }

  target = totalTarget * fraction;

  // Set minimum and maximum targets
  if (target < -info.maxDischarge) target = -info.maxDischarge;
  if (target > info.maxCharge) target = info.maxCharge;
  if ((target < minLoad) && (target > -minLoad)) target = 0;

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

const distributeRemainingPower = (strategy, totalTarget) => {
  const totalStratTarget = strategy.reduce((sum, currentValue) => sum + currentValue.target, 0);
  const totalDelta = (totalTarget - totalStratTarget);

  if (Math.abs(totalDelta) <= 10) return strategy;

  let restDelta = totalDelta;
  const maxSocDelta = 0;

  // Distribute remaining power over active batteries that have not reached limit
  const activeBatsWithHeadroom = strategy.filter((info) => info.target && info.headroom);
  const totalHeadroom = activeBatsWithHeadroom.reduce((sum, currentValue) => sum + currentValue.headroom, 0);

  if (activeBatsWithHeadroom.length) {
    strategy = strategy.map((info) => {
      if (!info.headroom || !info.target || (Math.abs(restDelta) < 10)) return info;

      let delta = restDelta * (info.headroom / totalHeadroom);
      if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom;
      if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom;

      restDelta -= delta;
      return {
        ...info,
        target: info.target + delta,
        headroom: info.headroom - delta,
      };
    });
  }

  if (Math.abs(restDelta) > 10) {
    // Use best SOC first, but only if significant better soc then running batt
    if (restDelta < 0) { // discharging
      strategy.sort((a, b) => b.soc - a.soc + maxSocDelta);
    } else { // charging
      strategy.sort((a, b) => a.soc - b.soc - maxSocDelta);
    }

    strategy = strategy.map((info) => {
      if (!info.headroom || (Math.abs(restDelta) < 10)) return info;

      let delta = restDelta;
      if (restDelta > 0 && (info.headroom < restDelta)) delta = info.headroom;
      if (restDelta < 0 && (info.headroom > restDelta)) delta = info.headroom;

      restDelta -= delta;
      return {
        ...info,
        target: info.target + delta,
        headroom: info.headroom - delta,
      };
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

  const totalBattSoc = batteryInfo.reduce((sum, currentValue) => sum + currentValue.soc, 0);
  const totalBattpower = batteryInfo.reduce((sum, currentValue) => sum + currentValue.actualPower, 0);
  const totalTarget = totalBattpower - (cumulativePower - x);
  const totalEmptySpace = batteryInfo.reduce((sum, currentValue) => sum + (100 - currentValue.soc), 0);

  let strategy = calculateStrategy(batteryInfo, totalTarget, totalBattSoc, totalEmptySpace, minLoad);
  strategy = distributeRemainingPower(strategy, totalTarget);

  return strategy;
};

module.exports = {
  getStrategy,
};
