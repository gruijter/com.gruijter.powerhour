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

class OpenMeteo {

  static async fetchForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation_instant&forecast_days=2&timezone=auto`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo API error: ${response.statusText}`);
    const data = await response.json();

    const result = {};
    if (data && data.hourly) {
      data.hourly.time.forEach((t, i) => {
        const time = new Date(t).getTime();
        result[time] = data.hourly.shortwave_radiation_instant[i];
      });
    }
    return result;
  }

  static async fetchHistoric(lat, lon, startDate, endDate) {
    const formatDate = (date) => date.toISOString().split('T')[0];
    const start = formatDate(startDate);
    const end = formatDate(endDate);

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=shortwave_radiation_instant&timezone=auto`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo Archive API error: ${response.statusText}`);
    const data = await response.json();

    const result = [];
    if (data && data.hourly && data.hourly.time && data.hourly.shortwave_radiation_instant) {
      data.hourly.time.forEach((t, i) => {
        const time = new Date(t).getTime();
        const radiation = data.hourly.shortwave_radiation_instant[i];
        if (typeof radiation === 'number') {
          result.push({ time, radiation });
        }
      });
    }
    return result;
  }

}

module.exports = OpenMeteo;
