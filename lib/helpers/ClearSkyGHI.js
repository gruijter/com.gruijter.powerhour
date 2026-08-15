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

// Theoretical (all-sky-independent) clear-sky Global Horizontal Irradiance, from solar
// position alone - no weather forecast, no historic data, works identically for any
// lat/lon/hemisphere/season/date. Unlike the empirical "best radiation ever seen in the
// training window" reference used elsewhere in this module, this has no cold-start problem:
// it's exact from sample #1, which matters now that the nightly batch retrain is the sole
// source of truth for the yield-factor model (no live learning fallback).
//
// Haurwitz (1945) clear-sky model, as implemented by pvlib.clearsky.haurwitz (verified
// against the pvlib source, 2026-08): GHI = 1098 * cos(zenith) * exp(-0.059 / cos(zenith))
// for zenith < 90 deg (sun above horizon), else 0. A simple, widely-used empirical fit
// requiring only solar position - deliberately not a more elaborate model (e.g. requiring
// aerosol optical depth or precipitable water), since none of those inputs are available
// here; this is used only as a loose sanity floor (see SolarLearningStrategy.js), not a
// precise irradiance prediction.
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
