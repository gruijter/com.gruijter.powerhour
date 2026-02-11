'use strict';

class Flows {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
  }

  register() {
    this.registerTriggers();
    this.registerConditions();
    this.registerActions();
  }

  registerTriggers() {
    const customRunListeners = {
      new_prices: async (args, state) => args.period === state.period,
      new_roi_strategy: async (args, state) => (args.minPriceDelta === state.minPriceDelta) && (!!args.invert_power === !!state.invert_power),
      xom_strategy: async (args, state) => state,
      new_hour: async (args, state) => state,
    };

    this.app.manifest.flow.triggers.forEach((trigger) => {
      const { id } = trigger;
      this.app[id] = this.homey.flow.getDeviceTriggerCard(id);

      if (customRunListeners[id]) {
        this.app[id].registerRunListener(customRunListeners[id]);
      } else {
        this.app[id].registerRunListener(async (args) => {
          if (args.device[id]) return args.device[id](args);
          if (args.device.runFlowTrigger) return args.device.runFlowTrigger(id, args);
          return Promise.reject(new Error(`Device ${args.device.getName()} has no method ${id}`));
        });
      }

      this.app.log('setting up flow trigger method', id);
      this.app[`trigger_${id}`] = (device, tokens, state) => {
        this.app[id]
          .trigger(device, tokens, state)
          .catch((err) => this.app.error(err));
      };
    });
  }

  registerConditions() {
    const customConditionMethods = {
      price_lowest_next_known_hours: 'price_lowest_next_hours',
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

  registerActions() {
    const customActionHandlers = {
      set_xom_settings: (card) => {
        card.registerRunListener(async (args) => {
          this.app.log('XOM settings set by flow:', args);
          this.homey.settings.set('xomSettings', args);
        });
      },
      set_tariff_power: (card) => card.registerRunListener((args) => this.homey.emit('set_tariff_power_PBTH', args)),
      set_tariff_gas: (card) => card.registerRunListener((args) => this.homey.emit('set_tariff_gas_PBTH', args)),
      set_tariff_water: (card) => card.registerRunListener((args) => this.homey.emit('set_tariff_water_PBTH', args)),
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
          if (args.device[id]) return args.device[id](args).catch((err) => this.app.error(err));
          if (args.device.runFlowAction) return args.device.runFlowAction(id, args).catch((err) => this.app.error(err));
          return Promise.reject(new Error(`Device ${args.device.getName()} has no method ${id}`));
        });
      }
    });
  }

  registerMeterAction(card, driverId) {
    card.registerRunListener((args) => this.runUpdateMeter(args, driverId).catch((err) => this.app.error(err)))
      .registerArgumentAutocompleteListener(
        'virtual_device',
        (query) => this.autoComplete(query, driverId).catch((err) => this.app.error(err)),
      );
  }

  async autoComplete(query, driverId) {
    const driver = await this.homey.drivers.getDriver(driverId);
    const devices = driver.getDevices()
      .filter((device) => device.getSettings().source_device_type === 'virtual via flow');
    const devicesMap = devices.map((device) => (
      {
        name: device.getName(),
        id: device.getData().id,
      }
    ));
    return devicesMap.filter((result) => result.name.toLowerCase().includes(query.toLowerCase()));
  }

  async runUpdateMeter(args, driverId) {
    const driver = await this.homey.drivers.getDriver(driverId);
    const device = driver.getDevices().find((d) => d.getData().id === args.virtual_device.id);
    if (!device) throw Error('Device not found');
    device.updateMeterFromFlow(args).catch((err) => this.app.error(err));
  }
}

module.exports = Flows;
