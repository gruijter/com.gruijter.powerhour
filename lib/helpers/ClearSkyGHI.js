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

const Astronomy = require('astronomy-engine');

// Theoretical clear-sky GHI from solar position only (no cold start). Haurwitz (1945), as in
// pvlib.clearsky.haurwitz (verified against the pvlib source): GHI = 1098 * cos(z) *
// exp(-0.059 / cos(z)) for zenith < 90 deg, else 0. Only a loose sanity floor
// (SolarLearningStrategy.js), not a precise prediction.
const estimateClearSkyGHI = (timestampMs, lat, lon) => {
  const date = new Date(timestampMs);
  const observer = new Astronomy.Observer(Number(lat), Number(lon), 0);
  const equator = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
  const horizon = Astronomy.Horizon(date, observer, equator.ra, equator.dec, 'normal');

  const cosZenith = Math.sin((horizon.altitude * Math.PI) / 180); // cos(90-altitude) = sin(altitude)
  if (cosZenith <= 0) return 0; // Sun at or below the horizon

  return 1098.0 * cosZenith * Math.exp(-0.059 / cosZenith);
};

module.exports = { estimateClearSkyGHI };
