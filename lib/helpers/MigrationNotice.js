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
// Both stop by themselves when the old devices are gone. Further:
//   welcome: once after the update from v8 - devices and flows keep working
//   cards:   flows with deprecated cards - a day after the welcome, then at most every 7 days;
//            stops when none are left (deprecated cards cannot be added anymore)
//   tariff:  an old tariff card ran for a group a price device also feeds - at most every 3 days

const PriceDrivers = require('./PriceDrivers');
const FlowScan = require('./FlowScan');

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLACE_EVERY_MS = 7 * DAY_MS;
const FLOWS_EVERY_MS = 3 * DAY_MS;
const CARDS_EVERY_MS = 7 * DAY_MS;
const TARIFF_EVERY_MS = 3 * DAY_MS;
const UPDATED_KEY = 'updatedFromV8'; // app setting: time of the update from v8
const FLOW_WARNING_KEY = 'tariffFlowWarning'; // store value on a price device: warning set
// Deprecated card -> its new card ('<type>:<id>'); the old tariff cards -> a price device.
const REPLACED_BY = {
  'action:set_meter_power': 'action:set_meter',
  'action:set_meter_gas': 'action:set_meter',
  'action:set_meter_water': 'action:set_meter',
  'action:set_daily_fixed_cost': 'action:set_fixed_cost',
  'action:set_monthly_fixed_cost': 'action:set_fixed_cost',
  'action:set_hourly_fixed_cost': 'action:set_fixed_cost',
  'action:set_ev_charge_mode': 'action:set_ev_charge_mode_for',
  'trigger:solar_yield_between': 'trigger:solar_yield_window',
  'trigger:solar_yield_remaining': 'trigger:solar_yield_window',
  'condition:solar_yield_between': 'condition:solar_yield_window',
  'condition:solar_yield_remaining': 'condition:solar_yield_window',
};
const PRICE_DEVICE_CARDS = ['action:set_tariff_power', 'action:set_tariff_gas', 'action:set_tariff_water'];
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

  // Called by a device migration with its level before: a level below 9 is the update from v8.
  static noteUpdate(homey, oldLevel) {
    if (!oldLevel || parseInt(String(oldLevel), 10) >= 9 || homey.settings.get(UPDATED_KEY)) return;
    homey.settings.set(UPDATED_KEY, Date.now());
  }

  title(card) {
    const t = card.title || {};
    return t[this.homey.i18n.getLanguage()] || t.en || card.id;
  }

  // One notification per deprecated card in use that has a replacement, with its flows. Returns the
  // number of notifications, null without the Homey API. Cards without one need nothing.
  async notifyCards() {
    const cards = await FlowScan.appCards(this.homey);
    if (!cards) return null;
    const deprecated = FlowScan.deprecatedCards(this.homey.manifest);
    const flows = new Map();
    cards.forEach((c) => {
      const key = `${c.type}:${c.card}`;
      if (!deprecated.has(key)) return;
      if (!flows.has(key)) flows.set(key, []);
      if (!flows.get(key).includes(c.flow)) flows.get(key).push(c.flow);
    });
    let count = 0;
    for (const [key, names] of flows) {
      const t = { card: this.title(deprecated.get(key)), flows: FlowScan.quote(names.sort((x, y) => x.localeCompare(y))) };
      const [type, id] = String(REPLACED_BY[key] || '').split(':');
      const replacement = id && ((this.homey.manifest.flow || {})[`${type}s`] || []).find((card) => card.id === id);
      let excerpt = null;
      if (PRICE_DEVICE_CARDS.includes(key)) excerpt = this.homey.__('migration_card_price', t);
      else if (replacement) excerpt = this.homey.__('migration_card_new', { ...t, new: this.title(replacement) });
      if (excerpt) {
        count += 1;
        await this.notify(excerpt);
      }
    }
    return count;
  }

  // An old tariff card ran for a group that a price device also feeds: the price device overwrites it.
  // Warning on the price device (cleared at its next start, drivers/price) and a notification.
  async tariffConflict(commodity, group, now = Date.now()) {
    const priceDevices = PriceDrivers.getDevices(this.homey, { commodity })
      .filter((d) => Number(d.getSettings().tariff_update_group) === Number(group));
    if (!priceDevices.length) return;
    // Old price devices keep their own migration warning.
    const warnDevices = priceDevices
      .filter((d) => !PriceDrivers.OLD_DRIVER_IDS.includes(d.driver.id) && !d.getStoreValue(FLOW_WARNING_KEY));
    const key = `tariff_${commodity}_${group}`;
    const last = this.last()[key];
    const notifyDue = !last || now - last >= TARIFF_EVERY_MS;
    if (!warnDevices.length && !notifyDue) return;
    if (notifyDue) this.setLast(key, now);
    const cards = await FlowScan.appCards(this.homey).catch((err) => {
      this.error('Flow lookup failed:', err);
      return null;
    });
    const flows = FlowScan.quote(FlowScan.tariffFlows(cards, commodity)[group]);
    const warning = flows ? this.homey.__('tariff_flow_warning', { flows }) : this.homey.__('tariff_flow_warning_unknown');
    for (const device of warnDevices) {
      await device.setWarning(warning).catch((err) => this.error(err));
      await device.setStoreValue(FLOW_WARNING_KEY, true).catch((err) => this.error(err));
    }
    if (!notifyDue) return;
    const device = priceDevices.map((d) => d.getName()).join(', ');
    await this.notify(flows
      ? this.homey.__('tariff_flow_conflict', { device, flows })
      : this.homey.__('tariff_flow_conflict_unknown', { device }));
  }

  // Per device the names of the flows and advanced flows that use it (its id anywhere in the flow:
  // cards, device arguments, tags), fetched once for all devices. null when the Homey API is not
  // available. capsOf: only cards/tags of those capabilities.
  async flowsUsing(devices, capsOf) {
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
        if (!text.includes(id)) return;
        const caps = capsOf && capsOf(device);
        const uses = !caps || new RegExp(`homey:device:${id}[:|](${caps.join('|')})(?![a-z0-9.]|_hidden)`).test(text);
        if (uses) names.get(device).push(flow.name);
      });
    });
    names.forEach((list) => list.sort((x, y) => x.localeCompare(y)));
    return names;
  }

  async notifyRenamedCaps(onCheck = () => {}) {
    const devices = Object.values(this.homey.drivers.getDrivers())
      .flatMap((driver) => driver.getDevices())
      .filter((device) => (device.getStoreValue('renamedCaps') || []).length);
    if (!devices.length) return;
    onCheck();
    const using = await this.flowsUsing(devices, (device) => device.getStoreValue('renamedCaps'));
    if (!using) return;
    for (const device of devices) {
      const flows = using.get(device) || [];
      if (flows.length) await this.notify(this.homey.__('migration_renamed_caps', { device: device.getName(), flows: FlowScan.quote(flows) }));
      else await device.unsetStoreValue('renamedCaps').catch((err) => this.error(err));
    }
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
        ? this.homey.__('migration_dap_flows', { ...names, flows: FlowScan.quote(flows) })
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
    const last = this.last();
    const updated = this.homey.settings.get(UPDATED_KEY);
    if (updated && !last.welcome) {
      this.setLast('welcome', now);
      await this.notify(this.homey.__('migration_welcome'));
    }
    const cardsDue = !last.cardsDone && (!last.cards || now - last.cards >= CARDS_EVERY_MS);
    if (cardsDue && (!updated || now - updated >= DAY_MS)) {
      this.setLast('cards', now);
      const count = await this.notifyCards().catch((err) => this.error('Flow lookup failed:', err));
      if (count === 0) this.setLast('cardsDone', true);
    }
    if (!last.renamed || now - last.renamed >= CARDS_EVERY_MS) {
      await this.notifyRenamedCaps(() => this.setLast('renamed', now)).catch((err) => this.error('Flow lookup failed:', err));
    }
    const devices = this.oldDevices();
    if (!devices.length) return;
    await this.setWarnings(devices);
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

MigrationNotice.FLOW_WARNING_KEY = FLOW_WARNING_KEY;

module.exports = MigrationNotice;
