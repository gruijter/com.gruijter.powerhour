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

module.exports = {
  async getSourceDevice(device) {
    let api;
    try {
      api = device.homey.app.api;
    } catch (e) {
      throw new Error('Homey API not ready or app destroyed');
    }
    if (!api) throw new Error('Homey API not ready');

    const sourceDevice = await api.devices.getDevice({ id: device.getSettings().homey_device_id, $cache: false })
      .catch((err) => device.error(err));
    const sourceDeviceExists = sourceDevice && sourceDevice.capabilitiesObj
      && Object.keys(sourceDevice.capabilitiesObj).length > 0 && (sourceDevice.available !== null);
    if (!sourceDeviceExists) throw Error('Source device is missing.');
    return sourceDevice;
  },
};
