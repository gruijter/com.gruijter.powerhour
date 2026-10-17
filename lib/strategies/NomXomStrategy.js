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

const BatterySplit = require('./BatterySplit');

// SoC above the battery's reserve (device.reservePct()): at the reserve it counts as empty.
const usableSoc = (device) => {
  const soc = Math.max(0, Math.min(100, device.soc));
  const r = typeof device.reservePct === 'function' ? device.reservePct() : 0;
  return r > 0 ? (Math.max(0, soc - r) * 100) / (100 - r) : soc;
};

// Real time: the meter is noisy, so a busy battery keeps its turn longer than in a plan.
const HYSTERESIS_PCT = 20;

const collectBatteryInfo = (devices) => devices
  .map((device) => {
    const settings = device.getSettings();
    const { chargeSpeeds, dischargeSpeeds } = BatterySplit.speedsFromSettings(settings);
    // capW: built-in control's cap on a battery that does not do its setpoint ({dir, w}).
    const cap = (dir) => (device.capW && device.capW.dir === dir ? device.capW.w : Infinity);
    return {
      id: device.getData().id,
      name: device.getName(),
      maxCharge: Math.min(Number(settings.chargePower) || 2000, cap(1)),
      maxDischarge: Math.min(Number(settings.dischargePower) || 2000, cap(-1)),
      effCharge: BatterySplit.efficientSpeed(chargeSpeeds),
      effDischarge: BatterySplit.efficientSpeed(dischargeSpeeds),
      soc: usableSoc(device),
      actualPower: device.getCapabilityValue('measure_watt_avg') || 0, // charge (+) / discharge (-)
      xomTargetPower: device.xomTargetPower || 0,
    };
  })
  .filter((info) => Number.isFinite(info.soc));

// The target over the batteries by BatterySplit (as the plan); a full battery takes no charge, an
// empty one (or at its reserve) gives nothing.
const calculateStrategy = (batteryInfo, totalTarget, minLoad) => {
  const charging = totalTarget > 0;
  const share = BatterySplit.split(batteryInfo.map((info) => {
    const room = charging ? info.soc < 99.9 : info.soc > 0.1;
    const maxW = charging ? info.maxCharge : info.maxDischarge;
    return {
      socPct: info.soc,
      speed: charging ? info.effCharge : info.effDischarge,
      maxW: room ? maxW : 0,
      active: charging ? info.xomTargetPower > 10 : info.xomTargetPower < -10,
    };
  }), Math.abs(totalTarget), charging, HYSTERESIS_PCT);
  return batteryInfo.map((info, i) => {
    let target = share[i] ? Math.sign(totalTarget) * share[i] : 0;
    // minLoad cutoff, only when the total target is small too
    if (Math.abs(target) < minLoad && Math.abs(totalTarget) < minLoad) target = 0;
    return {
      ...info,
      target,
      headroomCharge: Math.max(0, info.maxCharge - target),
      headroomDischarge: Math.max(0, info.maxDischarge + target),
      fraction: target / totalTarget,
    };
  });
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

  return calculateStrategy(batteryInfo, totalTarget, safeMinLoad);
};

module.exports = {
  getStrategy,
};
