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

const Energyzero = require('./Energyzero');

// EasyEnergy has deprecated their open API endpoint.
// This class acts as a transparent proxy to EnergyZero to ensure existing
// user devices do not break and continue fetching TTF gas prices seamlessly.
class Easyenergy extends Energyzero {

  constructor(opts) {
    super(opts);
    // Maintain the legacy bidding zone name for backward compatibility
    this.biddingZones = {
      TTF_LEBA_EasyEnergy: 'TTF_LEBA_EasyEnergy',
    };
  }
}

module.exports = Easyenergy;
