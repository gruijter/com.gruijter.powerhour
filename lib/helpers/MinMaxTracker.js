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

// Min/max of a measured value (power, flow) over three independently-resetting windows: day,
// month and year. Shared by the sum meters and the EV charger; the device stores the state.
//
// NOTE: deliberately no "quarter" (15-min) period - a min/max of instantaneous-ish readings
// WITHIN a 15-min window is a different metric than the AVERAGE power over that whole window
// (total energy / 0.25h), which is what BE/NL capacity tariffs actually bill on.
//
// Period boundaries come from the reading's own calendar fields (MeterHelpers.getReadingObject),
// so realtime callers without a periods object can use it too.

const createState = (reading) => ({
  reading,
  day: {
    min: null, max: null, day: null, month: null,
  },
  month: {
    min: null, max: null, month: null, year: null,
  },
  year: { min: null, max: null, year: null },
});

// False for a missing state, or an old single-pair one ({wattMax, wattMin, reading, reset}).
const hasShape = (state) => !!(state && state.day && state.month && state.year);

/**
 * Roll over each period whose boundary was crossed, then take val into account. Mutates state.
 * @returns {boolean} true when a min/max changed
 */
const update = (state, val, reading) => {
  const { day, month, year } = state;
  let changed = false;

  // Guarded by "!== null" so the very first-ever reading (all anchors still null from pair
  // init) doesn't spuriously "reset" an already-empty period.
  if (day.day !== null && (day.day !== reading.day || day.month !== reading.month)) {
    day.min = null; day.max = null; changed = true;
  }
  if (month.month !== null && (month.month !== reading.month || month.year !== reading.year)) {
    month.min = null; month.max = null; changed = true;
  }
  if (year.year !== null && year.year !== reading.year) {
    year.min = null; year.max = null; changed = true;
  }
  day.day = reading.day; day.month = reading.month;
  month.month = reading.month; month.year = reading.year;
  year.year = reading.year;

  [day, month, year].forEach((period) => {
    if (period.max === null || val > period.max) {
      period.max = val; changed = true;
    }
    if (period.min === null || val < period.min) {
      period.min = val; changed = true;
    }
  });
  return changed;
};

// Capability values, e.g. prefix 'measure_watt' -> {'measure_watt_max.day': ..., ...}
const capabilityValues = (state, prefix) => ({
  [`${prefix}_max.day`]: state.day.max,
  [`${prefix}_min.day`]: state.day.min,
  [`${prefix}_max.month`]: state.month.max,
  [`${prefix}_min.month`]: state.month.min,
  [`${prefix}_max.year`]: state.year.max,
  [`${prefix}_min.year`]: state.year.min,
});

module.exports = {
  createState,
  hasShape,
  update,
  capabilityValues,
};
