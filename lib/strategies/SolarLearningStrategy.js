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

const getStrategy = ({
  currentPower,
  forecastData,
  yieldFactors,
  timestamp = new Date(),
}) => {
  const result = {
    yieldFactors: [...yieldFactors],
    updated: false,
    log: null,
  };

  // Round to nearest hour for forecast lookup (Open-Meteo is hourly)
  const hourTime = new Date(timestamp);
  hourTime.setMinutes(0, 0, 0);
  const forecastRadiation = forecastData[hourTime.getTime()];

  if (forecastRadiation === undefined || forecastRadiation < 50) {
    // Ignore low radiation or missing data
    return result;
  }

  // Ensure positive power (PV generation)
  const power = Math.max(0, currentPower);

  const yieldFactor = power / forecastRadiation;

  // Update EMA
  const slotIndex = (timestamp.getHours() * 4) + Math.floor(timestamp.getMinutes() / 15);
  const oldYield = result.yieldFactors[slotIndex] !== undefined ? result.yieldFactors[slotIndex] : 1.0;
  const alpha = 0.2; // Learning rate
  const newYield = (alpha * yieldFactor) + ((1 - alpha) * oldYield);

  result.yieldFactors[slotIndex] = newYield;
  result.updated = true;
  result.log = `Updated yield factor for slot ${slotIndex}: ${oldYield.toFixed(2)} -> ${newYield.toFixed(2)} (P=${power}, R=${forecastRadiation})`;

  return result;
};

module.exports = { getStrategy };