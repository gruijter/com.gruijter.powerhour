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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const { Driver } = require('homey');
const crypto = require('crypto');

class MyDriver extends Driver {

  async onDriverInit() {
    this.log('onDriverInit');
  }

  async onUninit() {
    this.log('dap driver onUninit called');
  }

  async onPairListDevices() {
    const randomId = crypto.randomBytes(3).toString('hex');
    // const devices = [{
    //  name: 'Gas TTF (EEX EOD)',
    //  data: {
    //   id: `Gas_TTF_EOD_${randomId}`,
    //  },
    //  capabilities: this.deviceCapabilitiesGas,
    //  settings: {
    //   biddingZone: 'TTF_EOD',
    //   description: 'Gas TTF End of Day',
    //   variableMarkup: 0,
    //   fixedMarkup: 0,
    //   exchangeRate: 1,
    //   sendTariff: false,
    //  },
    // },
    // {
    //  name: 'Gas TTF (LEBA)',
    //  data: {
    //   id: `Gas_TTF_LEBA_${randomId}`,
    //  },
    //  capabilities: this.deviceCapabilitiesGas,
    //  settings: {
    //   biddingZone: 'TTF_LEBA',
    //   description: 'Gas TTF LEBA',
    //   variableMarkup: 0,
    //   fixedMarkup: 0,
    //   exchangeRate: 1,
    //   sendTariff: false,
    //  },
    // }];
    const devices = [];
    Object.entries(this.ds.biddingZones).forEach((entry) => {
      const [description, biddingZone] = entry;
      devices.push({
        name: `${description}`,
        data: {
          id: `${biddingZone}_${randomId}`,
        },
        capabilities: this.ds.deviceCapabilities,
        settings: {
          biddingZone,
          description,
          variableMarkup: 0,
          fixedMarkup: 0,
          exchangeRate: 1,
          tariff_update_group: 0,
        },
      });
    });
    return devices;
  }

}

module.exports = MyDriver;
