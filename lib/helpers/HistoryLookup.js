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

/**
 * Find the closest sample to timeMs in a { time, [valueKey]: number } time-series array,
 * within windowMs. Dependency-free (no `this`) so it can be called both as the implementation
 * behind ChargeDeviceHelpers' device-instance methods (getActualPowerForTime/getActualSocForTime)
 * and directly from the solar/grid chart renderers, which are plain functions with no device
 * instance to mix helpers into.
 *
 * @param {Array<{time: number}>} history - time-series array, entries shaped { time, [valueKey]: number }
 * @param {number} timeMs - Unix timestamp in milliseconds to look up
 * @param {number} windowMs - maximum allowed distance from timeMs, in milliseconds
 * @param {string} valueKey - property name holding the numeric value (e.g. 'power', 'soc')
 * @returns {number|null} the closest value within the window, or null if none found
 */
const findClosestSample = (history, timeMs, windowMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  const candidates = history.filter((d) => Math.abs(d.time - timeMs) < windowMs);
  if (candidates.length === 0) return null;
  const closest = candidates.sort((a, b) => Math.abs(a.time - timeMs) - Math.abs(b.time - timeMs))[0];
  return typeof closest[valueKey] === 'number' ? closest[valueKey] : null;
};

module.exports = { findClosestSample };
