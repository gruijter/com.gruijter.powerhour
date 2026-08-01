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
 * Homey App API — inter-app communication endpoints.
 *
 * Other Homey apps can consume these endpoints via:
 *   const phApi = this.homey.api.getApiApp('com.gruijter.powerhour');
 *   const data  = await phApi.get('/dap-prices');
 *
 * They can also subscribe to realtime push events:
 *   phApi.on('realtime', ({ name, data }) => { ... });
 * The event name emitted on every slot change and on new price fetch is:
 *   'dap-prices-updated'
 */

module.exports = [
  {
    description: 'Get all future DAP/DAP15/DAPg import+export price slots for every configured device',
    method: 'GET',
    path: '/dap-prices',
    fn: async function fn({ homey }) {
      return homey.app.getDapPricesPayload();
    },
  },
];
