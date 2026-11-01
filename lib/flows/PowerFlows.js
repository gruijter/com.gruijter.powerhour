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

/* eslint-disable camelcase */

'use strict';

const SumFlows = require('./SumFlows');

class PowerFlows extends SumFlows {
  async appliance_plan(args) {
    return this.device.planAppliance(args.time);
  }

  async appliance_plan_between(args) {
    return this.device.planApplianceBetween(args.from, args.to);
  }

  async appliance_plan_cancel() {
    await this.device.setAppliancePlan(null);
    return true;
  }

  async appliance_cheapest_start_between(args) {
    return this.device.isCheapestStartBetween(args.from, args.to);
  }

  async appliance_cheapest_start_next_hours(args) {
    return this.device.isCheapestStartNextHours(args.period);
  }
}

module.exports = PowerFlows;
