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

const RAD = Math.PI / 180;
const J2000_DAYS = 10957.5;

const sinSunAltitude = (timestampMs, lat, lon) => {
  const d = timestampMs / 86400000 - J2000_DAYS;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstHours = (18.697374558 + 24.06570982441908 * d) % 24;
  const hourAngle = (gmstHours * 15 + Number(lon)) * RAD - ra;
  const phi = Number(lat) * RAD;
  return Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle);
};

const estimateClearSkyGHI = (timestampMs, lat, lon) => {
  const cosZenith = sinSunAltitude(timestampMs, lat, lon);
  if (cosZenith <= 0) return 0;

  return 1098.0 * cosZenith * Math.exp(-0.059 / cosZenith);
};

module.exports = { estimateClearSkyGHI };
