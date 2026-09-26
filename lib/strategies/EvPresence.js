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

// Where is the car, and can it take power from this charger right now? Pure: the device collects
// the signals, this only combines them. Every signal is optional, so the same rules serve a
// wallbox with its own plug state, a smart plug with a car app that reports location, and a
// plain smart plug with nothing else.
//
// Car apps often only report after a trip has ended (parked), so their location and plug state
// can be hours old. Location is still the best home/away signal. Plug state only counts when it
// says "plugged in": a stale "plugged out" from the moment of parking says nothing about whether
// the cable went in afterwards.

// Charger power (W) above which the car is taking power. Above standby draw of a smart plug.
const CHARGING_POWER_W = 200;

// Car within this distance (km) of the Homey location counts as at home.
const HOME_RADIUS_KM = 0.25;

// Charger switched on for this long without the car taking power: the car is not charging
// (not plugged in, full, its own limit reached, or not actually home yet).
const NO_RESPONSE_MS = 10 * 60 * 1000;

// Legacy fallback without any other signal: no power for this long counts as departed. Same value
// as EvDepartureStrategy.SESSION_GAP_MS, which bootstraps from the same kind of power history.
const POWER_GAP_MS = 2 * 60 * 60 * 1000;

const STATES = ['unknown', 'away', 'home', 'plugged_in', 'charging'];

const isPluggedValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (value === 'plugged_out' || value === 'disconnected') return false;
  return value.startsWith('plugged_in') || value === 'charging';
};

/**
 * Great-circle distance in km.
 */
const distanceKm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * @param {object} s - signals, all optional
 * @param {number} s.now - ms
 * @param {number|null} s.powerW - live charger power
 * @param {number|null} s.lastChargingTm - last time power was above CHARGING_POWER_W
 * @param {boolean|null} s.chargerPlugged - the charger's own plug state (wallbox)
 * @param {boolean|null} s.carPlugged - the car's own plug state (anywhere, possibly stale)
 * @param {number|null} s.carDistanceKm - car distance from home
 * @param {boolean|null} s.switchOn - charger relay state, when this device can switch it
 * @param {number|null} s.switchOnSince - ms since the relay is on
 * @param {boolean} s.usePowerGap - allow the legacy power-gap fallback
 * @returns {{state: string, atHome: boolean, chargeable: boolean}}
 *   atHome: plan with the live SoC and let the charger follow the plan.
 *   chargeable: the car takes, or is expected to take, power when the charger is on.
 */
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

  const result = (state) => ({
    state,
    atHome: state !== 'away',
    chargeable: state === 'charging' || state === 'plugged_in' || ((state === 'home' || state === 'unknown') && !noResponse),
  });

  // Power at this charger while the car is known to be elsewhere: another car.
  if (powerOn && !locationAway) {
    // Without location, a car that says it is unplugged is not the one charging here.
    if (!hasLocation && chargerPlugged === null && carPlugged === false) return result('away');
    return result('charging');
  }

  if (chargerPlugged === true) return result(locationAway ? 'away' : 'plugged_in');

  if (hasLocation) {
    if (locationAway) return result('away');
    return result(carPlugged === true ? 'plugged_in' : 'home');
  }

  // The charger's own plug state is location accurate: unplugged means gone.
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
