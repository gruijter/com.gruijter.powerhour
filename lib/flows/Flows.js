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

const PriceDrivers = require('../helpers/PriceDrivers');

class Flows {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
  }

  register() {
    this.registerTriggers();
    this.registerConditions();
    this.registerActions();

    // Load XOM settings from persistence
    const xomSettings = this.homey.settings.get('xomSettings');
    if (xomSettings) {
      this.app.xomSettings = xomSettings;
      this.app.log('Restored XOM settings:', xomSettings);
    }
  }

  registerTriggers() {
    const customRunListeners = {
      new_prices: async (args, state) => args.period === state.period
        && (args.includeForecast !== false || !state.isForecast),
      solar_forecast_updated: async (args, state) => args.period === state.period,
      load_forecast_updated: async (args, state) => args.period === state.period,
      peak_projected_exceeded: async () => true,
      // Device-only EV cards: no args to match, every flow on the device runs.
      ev_not_plugged_in: async () => true,
      new_ev_strategy: async () => true,
      new_roi_strategy: async (args, state) => (args.minPriceDelta === state.minPriceDelta) && (!!args.invert_power === !!state.invert_power),
      battery_plan_power: async (args, state) => !!args.invert_power === !!state.invert_power,
      xom_strategy: async (args, state) => !!args.invert_power === !!state.invert_power,
      new_hour: async (args, state) => (state !== undefined ? state : true),
      price_new_prices: async (args, state) => args.period === state.period
        && (args.includeForecast !== false || !state.isForecast),
      price_new_period: async () => true,
    };

    const customTriggerMethods = {
      price_lowest_next_known_hours: 'price_lowest_next_hours',
      price_highest_next_known_hours: 'price_highest_next_hours',
    };

    this.app.manifest.flow.triggers.forEach((trigger) => {
      const { id } = trigger;
      this.app[id] = this.homey.flow.getDeviceTriggerCard(id);
      const method = customTriggerMethods[id] || id;

      if (customRunListeners[id]) {
        this.app[id].registerRunListener(customRunListeners[id]);
      } else {
        this.app[id].registerRunListener(async (args, state) => {
          if (args.device[method]) return args.device[method](args);
          if (args.device.runFlowTrigger) return args.device.runFlowTrigger(method, args, state);
          return Promise.reject(new Error(`Device ${args.device.getName()} has no method ${method}`));
        });
      }

      this.app.log('setting up flow trigger method', id);
      this.app[`trigger_${id}`] = (device, tokens, state) => {
        let triggerTokens = tokens;
        if (id === 'xom_strategy' && tokens && typeof tokens.power !== 'undefined') {
          triggerTokens = { ...tokens, power: Number(tokens.power) };
        }
        return this.app[id]
          .trigger(device, triggerTokens, state)
          .catch((err) => this.app.error(err));
      };
    });
  }

  registerConditions() {
    const customConditionMethods = {
      price_lowest_next_known_hours: 'price_lowest_next_hours',
      price_highest_next_known_hours: 'price_highest_next_hours',
    };

    this.app.manifest.flow.conditions.forEach((condition) => {
      const { id } = condition;
      const card = this.homey.flow.getConditionCard(id);
      const method = customConditionMethods[id] || id;

      this.app.log('setting up flow condition listener', id);
      card.registerRunListener((args) => {
        if (args.device[method]) return args.device[method](args);
        if (args.device.runFlowCondition) return args.device.runFlowCondition(method, args);
        return Promise.reject(new Error(`Device ${args.device.getName()} has no method ${method}`));
      });
    });
  }

  // Action card errors: log and rethrow, so the error (e.g. an invalid time) reaches the user's flow.
  failFlow(err) {
    this.app.error(err);
    throw err;
  }

  registerActions() {
    const fail = (err) => this.failFlow(err);
    const customActionHandlers = {
      set_xom_settings: (card) => {
        card.registerRunListener(async (args) => {
          // An empty field keeps its value.
          const xs = { ...(this.app.xomSettings || this.homey.settings.get('xomSettings') || {}) };
          ['x', 'smoothing', 'minLoad'].forEach((key) => {
            if (args[key] === undefined || args[key] === null || args[key] === '') return;
            const value = Number(args[key]);
            if (!Number.isFinite(value)) throw Error(this.homey.__('error_value_not_number'));
            xs[key] = value;
          });
          this.app.log('XOM settings set by flow:', xs);
          // settings.set() returns void (@types/homey): no promise to catch.
          this.homey.settings.set('xomSettings', xs);
          this.app.xomSettings = xs;
          try {
            this.homey.drivers.getDriver('battery').onXomFlow();
          } catch {
            // no battery driver ready
          }
        });
      },
      set_tariff_power: (card) => card.registerRunListener((args) => this.applyTariffToGroup('power', args).catch(fail)),
      set_tariff_gas: (card) => card.registerRunListener((args) => this.applyTariffToGroup('gas', args).catch(fail)),
      set_tariff_water: (card) => card.registerRunListener((args) => this.applyTariffToGroup('water', args).catch(fail)),
      set_meter: (card) => this.registerMeterAction(card, 'all'),
      set_meter_power: (card) => this.registerMeterAction(card, 'power'),
      set_meter_gas: (card) => this.registerMeterAction(card, 'gas'),
      set_meter_water: (card) => this.registerMeterAction(card, 'water'),
    };

    this.app.manifest.flow.actions.forEach((action) => {
      const { id } = action;
      const card = this.homey.flow.getActionCard(id);

      if (customActionHandlers[id]) {
        customActionHandlers[id](card);
      } else {
        this.app.log('setting up flow action listener', id);
        card.registerRunListener((args) => {
          if (args.device[id]) return args.device[id](args).catch(fail);
          if (args.device.runFlowAction) return args.device.runFlowAction(id, args).catch(fail);
          return Promise.reject(new Error(`Device ${args.device.getName()} has no method ${id}`));
        });
      }
    });
  }

  // Driver ids that react to each tariff broadcast group, mirroring the hardcoded event-name
  // mapping inside generic_sum_driver.js (solar/grid remapped to 'power', gas/water on their own
  // name) and generic_bat_driver.js (battery/evCharger always listen on the 'power' broadcast).
  static TARIFF_GROUP_DRIVER_IDS = {
    power: ['power', 'grid', 'solar', 'battery', 'evCharger'],
    gas: ['gas'],
    water: ['water'],
  };

  // Calls each driver's applyTariffFromEvent() and awaits it, so the flow card resolves when the
  // tariff is written. Every driver gets it; the first failure is thrown after.
  async applyTariffToGroup(groupType, args) {
    // Checked once here for all drivers (a tag can give a non-number).
    if (args.tariff === null || args.tariff === undefined || args.tariff === '' || !Number.isFinite(Number(args.tariff))) {
      throw Error(this.homey.__('error_value_not_number'));
    }
    const driverIds = Flows.TARIFF_GROUP_DRIVER_IDS[groupType] || [];
    const results = await Promise.allSettled(driverIds.map(async (driverId) => {
      let driver;
      try {
        driver = this.homey.drivers.getDriver(driverId);
      } catch {
        return; // driver not loaded (no devices of this type paired)
      }
      if (driver && typeof driver.applyTariffFromEvent === 'function') {
        await driver.applyTariffFromEvent(args);
      }
    }));
    // The flow tariff replaced the receivers' price list: a price device feeding the same group
    // sends its next list in full again instead of a shift-only skip (PriceShift.isShiftOnly()).
    PriceDrivers.DRIVER_IDS.forEach((driverId) => {
      try {
        this.homey.drivers.getDriver(driverId).getDevices().forEach((d) => {
          d.lastBroadcast = null;
        });
      } catch {
        // driver not loaded
      }
    });
    const failed = results.filter((r) => r.status === 'rejected');
    failed.slice(1).forEach((r) => this.app.error(r.reason));
    if (failed.length > 0) throw failed[0].reason;
  }

  // Drivers whose pairing offers a virtual meter fed by each meter card (generic_sum_driver.js).
  static METER_DRIVER_IDS = {
    all: ['power', 'grid', 'solar', 'gas', 'water'],
    power: ['power', 'grid', 'solar'],
    gas: ['gas'],
    water: ['water'],
  };

  registerMeterAction(card, meterType) {
    card.registerRunListener((args) => this.runUpdateMeter(args, meterType).catch((err) => this.failFlow(err)))
      .registerArgumentAutocompleteListener(
        'virtual_device',
        (query) => this.autoComplete(query, meterType).catch((err) => this.app.error(err)),
      );
  }

  virtualMeters(meterType) {
    return (Flows.METER_DRIVER_IDS[meterType] || []).flatMap((driverId) => {
      try {
        return this.homey.drivers.getDriver(driverId).getDevices();
      } catch {
        return []; // driver not loaded
      }
    }).filter((device) => device.getSettings().source_device_type === 'virtual via flow');
  }

  // The driver name as description: a virtual grid and power meter may have the same name.
  async autoComplete(query, meterType) {
    const lang = this.homey.i18n.getLanguage();
    return this.virtualMeters(meterType)
      .map((device) => {
        const name = (device.driver.manifest && device.driver.manifest.name) || {};
        return { name: device.getName(), description: name[lang] || name.en, id: device.getData().id };
      })
      .filter((result) => result.name.toLowerCase().includes(query.toLowerCase()));
  }

  async runUpdateMeter(args, meterType) {
    const device = this.virtualMeters(meterType).find((d) => d.getData().id === args.virtual_device.id);
    if (!device) throw Error(this.homey.__('error_device_not_found'));
    await device.updateMeterFromFlow(args);
  }
}

module.exports = Flows;
