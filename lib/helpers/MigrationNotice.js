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

// Timeline notifications and device warnings for the move from the old DAP drivers to the price
// driver, as PriceIntervalGroups.notifyConflict(), but repeated far less often: the time of the
// last notification is kept in the app settings, so a restart does not repeat it.
//   replace: old DAP devices not taken over - at most every 7 days
//   flows:   old DAP devices taken over (pairing a price device), not yet deleted - right away,
//            then at most every 3 days, with the flows that still use the old device
// Both stop by themselves when the old devices are gone.

const PriceDrivers = require('./PriceDrivers');

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLACE_EVERY_MS = 7 * DAY_MS;
const FLOWS_EVERY_MS = 3 * DAY_MS;
const FIRST_CHECK_MS = 60 * 1000;
const SETTINGS_KEY = 'migrationNoticeLast';
const TAKEN_OVER_KEY = 'takenOverBy'; // store value on an old device: name of the price device

class MigrationNotice {

  constructor(homey) {
    this.homey = homey;
    this.warnings = new Map(); // device -> warning set this session
  }

  // First check a minute after the start (device names known), then every hour.
  start() {
    this.firstCheckId = this.homey.setTimeout(() => this.check().catch((err) => this.error(err)), FIRST_CHECK_MS);
    this.onHour = () => this.check().catch((err) => this.error(err));
    this.homey.on('everyhour_PBTH', this.onHour);
  }

  stop() {
    if (this.firstCheckId) this.homey.clearTimeout(this.firstCheckId);
    if (this.onHour) this.homey.removeListener('everyhour_PBTH', this.onHour);
  }

  error(...args) {
    try {
      this.homey.app.error(...args);
    } catch {
      // app not reachable
    }
  }

  oldDevices() {
    return PriceDrivers.getDevices(this.homey, { driverIds: PriceDrivers.OLD_DRIVER_IDS });
  }

  last() {
    return this.homey.settings.get(SETTINGS_KEY) || {};
  }

  setLast(kind, now) {
    this.homey.settings.set(SETTINGS_KEY, { ...this.last(), [kind]: now });
  }

  // Per device the names of the flows and advanced flows that use it (its id anywhere in the flow:
  // cards, device arguments, tags), fetched once for all devices. null when the Homey API is not
  // available.
  async flowsUsing(devices) {
    const { api } = this.homey.app;
    if (!api) return null;
    const apiDevices = Object.values(await api.devices.getDevices());
    const ids = new Map();
    devices.forEach((device) => {
      const { id: dataId } = device.getData();
      const apiDevice = apiDevices.find((d) => d.data && d.data.id === dataId && String(d.driverId).includes('com.gruijter.powerhour'));
      if (apiDevice) ids.set(device, apiDevice.id);
    });
    const names = new Map([...ids.keys()].map((device) => [device, []]));
    const lists = await Promise.all([api.flow.getFlows(), api.flow.getAdvancedFlows()]);
    lists.flatMap((list) => Object.values(list || {})).forEach((flow) => {
      const text = JSON.stringify(flow);
      ids.forEach((id, device) => {
        if (text.includes(id)) names.get(device).push(flow.name);
      });
    });
    names.forEach((list) => list.sort((x, y) => x.localeCompare(y)));
    return names;
  }

  async notify(excerpt) {
    try {
      this.homey.app.log('Migration notification:', excerpt);
      await this.homey.notifications.createNotification({ excerpt });
    } catch (error) {
      this.error('Failed to create migration notification:', error);
    }
  }

  async notifyFlows(devices) {
    const using = await this.flowsUsing(devices).catch((err) => {
      this.error('Flow lookup failed:', err);
      return null;
    });
    for (const device of devices) {
      const names = { old: device.getName(), new: device.getStoreValue(TAKEN_OVER_KEY) };
      const flows = using && using.get(device);
      const excerpt = flows && flows.length
        ? this.homey.__('migration_dap_flows', { ...names, flows: flows.join(', ') })
        : this.homey.__('migration_dap_delete', names);
      await this.notify(excerpt);
    }
  }

  // Called after a price device took over the settings of an old device.
  async takenOver(device, newName) {
    await device.setStoreValue(TAKEN_OVER_KEY, newName);
    await this.setWarnings([device]);
    this.setLast('flows', Date.now());
    await this.notifyFlows([device]);
  }

  async setWarnings(devices) {
    for (const device of devices) {
      const newName = device.getStoreValue(TAKEN_OVER_KEY);
      const warning = newName
        ? this.homey.__('migration_warning_taken', { new: newName })
        : this.homey.__('migration_warning_replace');
      if (this.warnings.get(device) === warning) continue;
      this.warnings.set(device, warning);
      await device.setWarning(warning).catch((err) => this.error(err));
    }
  }

  async check(now = Date.now()) {
    const devices = this.oldDevices();
    if (!devices.length) return;
    await this.setWarnings(devices);
    const last = this.last();
    const taken = devices.filter((d) => d.getStoreValue(TAKEN_OVER_KEY));
    const notTaken = devices.filter((d) => !d.getStoreValue(TAKEN_OVER_KEY));

    if (notTaken.length && (!last.replace || now - last.replace >= REPLACE_EVERY_MS)) {
      this.setLast('replace', now);
      await this.notify(this.homey.__('migration_dap_replace', { devices: notTaken.map((d) => d.getName()).join(', ') }));
    }
    if (taken.length && (!last.flows || now - last.flows >= FLOWS_EVERY_MS)) {
      this.setLast('flows', now);
      await this.notifyFlows(taken);
    }
  }

}

module.exports = MigrationNotice;
