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

// Homey gives a device with meter_power or measure_power its own Energy settings (energy_exclude "Exclude
// from Energy", energy_value_constant). The app cannot set them (tested on Dev 2026-11-16: the device's
// setSettings has no effect, the Web API setDeviceSettings answers 'Missing Scopes'), only the user can.
// A change to them reaches the device's onSettings: nothing to do there (no restart).

class EnergyExclude {

  // Only Homey's own Energy settings changed.
  static onlyHomeyEnergy(changedKeys) {
    return Array.isArray(changedKeys) && changedKeys.length > 0 && changedKeys.every((key) => key.startsWith('energy_'));
  }

}

module.exports = EnergyExclude;
