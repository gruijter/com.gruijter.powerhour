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
const BatteryUse = require('./BatteryUse');

const usableSoc = (device) => {
  const soc = Math.max(0, Math.min(100, device.soc));
  const r = typeof device.reservePct === 'function' ? device.reservePct() : 0;
  return r > 0 ? (Math.max(0, soc - r) * 100) / (100 - r) : soc;
};

const HYSTERESIS_PCT = 20;

const collectBatteryInfo = (devices) => devices
  .map((device) => {
    const settings = typeof device.batterySettings === 'function' ? device.batterySettings() : device.getSettings();
    const { chargeSpeeds, dischargeSpeeds } = BatterySplit.speedsFromSettings(settings);
    const cap = (dir) => (device.capW && device.capW.dir === dir ? device.capW.w : Infinity);
    const effCharge = BatterySplit.efficientSpeed(chargeSpeeds);
    const effDischarge = BatterySplit.efficientSpeed(dischargeSpeeds);
    return {
      id: device.getData().id,
      name: device.getName(),
      maxCharge: Math.min(Number(settings.chargePower) || 2000, cap(1)),
      maxDischarge: Math.min(Number(settings.dischargePower) || 2000, cap(-1)),
      effCharge,
      effDischarge,
      soc: usableSoc(device),
      wear: Number(settings.wearCost) || 0,
      cycles: device.use ? device.use.cycles : 0,
      actualPower: device.getCapabilityValue('measure_watt_avg') || 0,
      xomTargetPower: device.xomTargetPower || 0,
    };
  })
  .filter((info) => Number.isFinite(info.soc));

const withCostClasses = (infos, devices) => {
  const refs = devices.map((d) => BatteryUse.refPrice(d.pricesNextHours)).filter((p) => p !== 0);
  const ref = refs.length ? refs.reduce((a, b) => a + b, 0) / refs.length : 0;
  const classes = BatteryUse.costClasses(infos.map((info) => ({
    wear: info.wear, effC: info.effCharge.eff, effD: info.effDischarge.eff,
  })), ref);
  return infos.map((info, i) => ({ ...info, costClass: classes[i] }));
};

const splitTarget = (batteryInfo, totalTarget, minLoad) => {
  const charging = totalTarget > 0;
  const share = BatterySplit.split(batteryInfo.map((info) => {
    const room = charging ? info.soc < 99.9 : info.soc > 0.1;
    const maxW = charging ? info.maxCharge : info.maxDischarge;
    return {
      socPct: info.soc,
      speed: charging ? info.effCharge : info.effDischarge,
      maxW: room ? maxW : 0,
      active: charging ? info.xomTargetPower > 10 : info.xomTargetPower < -10,
      costClass: info.costClass,
      cycles: info.cycles,
    };
  }), Math.abs(totalTarget), charging, HYSTERESIS_PCT);
  return batteryInfo.map((info, i) => {
    let target = share[i] ? Math.sign(totalTarget) * share[i] : 0;
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

const split = ({
  devices,
  cumulativePower,
  x = 0,
  minLoad = 50,
}) => {
  const batteryInfo = withCostClasses(collectBatteryInfo(devices), devices);
  if (!batteryInfo || batteryInfo.length === 0) return [];

  const totalBattpower = batteryInfo.reduce((sum, info) => sum + (info.xomTargetPower || 0), 0);
  const safeX = Number(x) || 0;
  const safeMinLoad = Number.isFinite(Number(minLoad)) ? Number(minLoad) : 50;

  const totalTarget = totalBattpower - (cumulativePower - safeX);

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

  return splitTarget(batteryInfo, totalTarget, safeMinLoad);
};

module.exports = {
  split,
};
