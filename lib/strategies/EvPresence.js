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

const CHARGING_POWER_W = 200;

const HOME_RADIUS_KM = 0.25;

const NO_RESPONSE_MS = 10 * 60 * 1000;

const POWER_GAP_MS = 2 * 60 * 60 * 1000;

const STATES = ['unknown', 'away', 'home', 'plugged_in', 'charging'];

const UNPLUGGED_VALUES = ['plugged_out', 'disconnected', 'unplugged', 'not_connected'];
const PLUGGED_VALUES = ['charging', 'connected', 'plugged'];

const isPluggedValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (UNPLUGGED_VALUES.includes(value)) return false;
  if (value.startsWith('plugged_in') || PLUGGED_VALUES.includes(value)) return true;
  return null;
};

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const resolvePresence = (s) => {
  const now = s.now || Date.now();
  const hasLocation = typeof s.carDistanceKm === 'number' && Number.isFinite(s.carDistanceKm);
  const locationAway = hasLocation && s.carDistanceKm > HOME_RADIUS_KM;
  const powerOn = typeof s.powerW === 'number' && s.powerW > CHARGING_POWER_W;
  const chargerPlugged = typeof s.chargerPlugged === 'boolean' ? s.chargerPlugged : null;
  const carPlugged = typeof s.carPlugged === 'boolean' ? s.carPlugged : null;
  const noResponse = s.switchOn === true && typeof s.switchOnSince === 'number'
    && (now - s.switchOnSince) > NO_RESPONSE_MS
    && !(typeof s.lastChargingTm === 'number' && s.lastChargingTm >= s.switchOnSince);

  const result = (state, unplugged = false) => ({
    state,
    atHome: state !== 'away',
    chargeable: !unplugged
      && (state === 'charging' || state === 'plugged_in' || ((state === 'home' || state === 'unknown') && !noResponse)),
    unplugged,
    noResponse,
  });

  if (typeof s.flowAwaySince === 'number' && !powerOn) return result('away');

  if (powerOn && (!locationAway || s.ownCharger)) {
    if (!s.ownCharger && !hasLocation && chargerPlugged === null && carPlugged === false) return result('away');
    return result('charging');
  }

  if (chargerPlugged === true || s.detectedPlugged === true) return result(locationAway && !s.ownCharger ? 'away' : 'plugged_in');

  if (hasLocation) {
    if (locationAway) return result('away');
    if (chargerPlugged === false) return result('home', true);
    return result(carPlugged === true ? 'plugged_in' : 'home', carPlugged === false);
  }

  if (chargerPlugged === false) return result('away');

  if (s.usePowerGap && typeof s.lastChargingTm === 'number') {
    return result((now - s.lastChargingTm) > POWER_GAP_MS ? 'away' : 'plugged_in');
  }

  if (carPlugged === true) return result('plugged_in');
  return result('unknown');
};

module.exports = {
  resolvePresence,
  isPluggedValue,
  distanceKm,
  STATES,
  CHARGING_POWER_W,
  HOME_RADIUS_KM,
  NO_RESPONSE_MS,
  POWER_GAP_MS,
};
