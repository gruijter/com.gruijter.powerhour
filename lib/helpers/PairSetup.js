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

const Budget = require('../Budget');
const PriceDrivers = require('./PriceDrivers');
const MoneyUnit = require('./MoneyUnit');

// Pairing and repairing with the setup view (drivers/<id>/pair|repair/setup.html): the source
// device from the list, then a driver's key settings and, per role, the capability of a linked
// device to use. A driver opts in with ds.setup = { settings: [ids], preset: { id: value },
// prices: 'power' (default) | 'gas' | 'water' | null (no price devices), requirePrice: pairing
// needs a price device in the tariff group } and can add:
//   setupSettings(dev)                         -> the setting ids for this listed device
//   setupInfo(setting, def, dev, current)      -> text under a setting
//   setupRoles(dev, stored)                    -> { deviceId, title, text, items } or null
//   setupStored(device) / setupStore(id, caps, dev) -> the role choice in the device store
//                                                 ({ key, value } or a list of them)
//   setupValidate(settings, caps, dev)         -> throws when the setup cannot work
//   repairActions(device)                      -> checkboxes in repair only ({ id, label, info }),
//                                                 a ticked one runs device.onRepairAction(id)
//   capabilitiesFor(settings)                  -> the capabilities to pair with
// Without ds.setup, repair only replaces the source device.
// A device with fixValues()/applyFixValues() also gets the repair view fix_values (lib/helpers/FixValues.js).

// A translation object from the manifest in the language of Homey.
const text = (homey, t) => {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t[homey.i18n.getLanguage() || 'en'] || t.en || '';
};

// App-managed settings: chosen in the setup view only, not on the settings page (a setting outside
// the manifest stays readable and writable, skill section 22).
const APP_SETTINGS = {
  use_measure_source: { type: 'checkbox', value: false, labelKey: 'repair.setup_use_watt' },
  homey_device_daily_reset: { type: 'checkbox', value: false, labelKey: 'repair.setup_daily_reset' },
};

// The driver settings from the manifest, and the app-managed ones, by id.
const settingDefs = (driver) => {
  const manifest = driver.homey.app.manifest.drivers.find((d) => d.id === driver.ds.driverId) || {};
  const defs = {};
  const walk = (list) => (list || []).forEach((s) => {
    if (s.children) walk(s.children);
    else defs[s.id] = s;
  });
  walk(manifest.settings);
  Object.entries(APP_SETTINGS).forEach(([id, def]) => {
    if (!defs[id]) defs[id] = { ...def, id, label: driver.homey.__(def.labelKey) };
  });
  return defs;
};

// The driver's price devices (ds.setup.prices) by tariff group: { group: [names] }.
const priceKind = (driver) => (driver.ds.setup.prices === undefined ? 'power' : driver.ds.setup.prices);
const dapGroups = (driver) => {
  const names = {};
  const kind = priceKind(driver);
  if (!kind) return names;
  PriceDrivers.getDevices(driver.homey, { commodity: kind }).forEach((dap) => {
    const group = Number(dap.getSettings().tariff_update_group);
    if (!group) return;
    (names[group] = names[group] || []).push(dap.getName());
  });
  return names;
};

// Tariff update groups with the names of the DAP devices in them, and when repairing the present
// group (it may be fed by flow). Pairing has no present group: the manifest default is none.
const tariffGroupOptions = (names, current) => {
  const groups = Object.keys(names).map(Number);
  if (typeof current === 'number' && !groups.includes(current)) groups.push(current);
  if (!groups.length) groups.push(1);
  return groups.sort((a, b) => a - b)
    .map((group) => ({ id: group, label: `${group}${names[group] ? `: ${names[group].join(', ')}` : ''}` }));
};

/**
 * How likely a Homey device is the wanted source, for the order of the list: the device class
 * (ds.setup.match.classes) first, then its energy object (ds.setup.match.energy), then detected
 * capabilities; devices to map manually last.
 */
const listScore = (driver, homeyDevice, compat = {}) => {
  const match = (driver.ds.setup && driver.ds.setup.match) || {};
  const energy = homeyDevice.energyObj || homeyDevice.energy || {};
  let score = 0;
  if ((match.classes || []).some((c) => c === homeyDevice.class || c === homeyDevice.virtualClass)) score += 4;
  if (match.energy && match.energy(energy)) score += 2;
  if (compat.found && !compat.needsMapping) score += 1;
  return score;
};

// Listed devices by score, highest first; equal scores keep their order.
const sortByScore = (entries) => entries
  .map((entry, i) => ({ ...entry, i }))
  .sort((a, b) => (b.score - a.score) || (a.i - b.i))
  .map(({ device }) => device);

// The tariff group the view starts with: the present one when repairing, else (pairing, where
// the manifest default is no choice) the first group with a DAP when that group has none.
const setupGroup = (settings, names, repairing) => {
  const group = Number(settings.tariff_update_group);
  const daps = Object.keys(names).map(Number);
  if (repairing || names[group] || !daps.length) return group;
  return Math.min(...daps);
};

// The setting ids to ask.
const setupIds = (driver, dev) => (driver.setupSettings ? driver.setupSettings(dev) : driver.ds.setup.settings);

// A listed device to map in the setup view is marked in its name; not the paired device.
const mapHint = (homey) => ` (${homey.__('repair.setup_map_manually')})`;
const listName = (driver, name, compat = {}) => (compat.needsMapping ? `${name}${mapHint(driver.homey)}` : name);
const pairName = (driver, name = '') => {
  const hint = mapHint(driver.homey);
  return name.endsWith(hint) ? name.slice(0, -hint.length) : name;
};
// The paired device gets the name of its source device (driver.sourceName: when the list shows more).
const sourceName = (driver, dev) => (driver.sourceName ? driver.sourceName(dev) : pairName(driver, dev.name));

// A HomeyAPI device, fresh, or null.
const apiDevice = async (driver, id) => {
  const { api } = driver.homey.app;
  if (!api || !id) return null;
  return api.devices.getDevice({ id, $cache: false }).catch(() => null);
};

const storedRoles = (driver, device) => (driver.setupStored
  ? driver.setupStored(device) : device.getStoreValue('sourceCaps'));

// A list of { key, value } for the device store.
const storeRoles = (driver, deviceId, caps, dev) => [].concat(driver.setupStore
  ? driver.setupStore(deviceId, caps, dev) : { key: 'sourceCaps', value: { sourceId: deviceId, caps } });

const pick = (obj, ids) => ids.reduce((out, id) => {
  if (obj && obj[id] !== undefined) out[id] = obj[id];
  return out;
}, {});

// The setup view content for the listed device dev. current: { settings, stored, device }.
const getSetup = async (driver, dev, current) => {
  const { homey } = driver;
  const defs = settingDefs(driver);
  const preset = driver.ds.setup.preset || {};
  const settings = [];
  const names = dapGroups(driver);
  const repairing = !!current.device;
  const ids = setupIds(driver, dev);
  for (const id of ids.filter((i) => defs[i])) {
    const def = defs[id];
    let value = current.settings[id] !== undefined ? current.settings[id] : def.value;
    if (preset[id] !== undefined) value = preset[id];
    const setting = {
      id, type: def.type, label: text(homey, def.label), value, min: def.min, max: def.max,
    };
    if (def.type === 'dropdown') setting.options = (def.values || []).map((v) => ({ id: v.id, label: text(homey, v.label) }));
    if (id === 'tariff_update_group' && priceKind(driver)) {
      setting.type = 'dropdown';
      setting.options = tariffGroupOptions(names, repairing ? value : undefined);
      setting.value = setupGroup({ tariff_update_group: value }, names, repairing);
      if (!setting.options.some((opt) => opt.id === setting.value)) setting.value = setting.options[0].id;
      // Without a price device: add one first, or for a charge plan a price device fed by flow.
      if (!Object.keys(names).length) {
        setting.info = homey.__(driver.ds.setup.requirePrice ? 'repair.setup_no_price' : 'repair.setup_no_dap_plan');
      }
    }
    if (driver.setupInfo) setting.info = (await driver.setupInfo(setting, def, dev, current)) || setting.info;
    settings.push(setting);
  }
  if (repairing && driver.repairActions) {
    driver.repairActions(current.device).forEach((a) => settings.push({ ...a, type: 'checkbox', value: false }));
  }
  const roles = driver.setupRoles ? await driver.setupRoles(dev, current.stored) : null;
  return { title: pairName(driver, dev.name), settings, roles };
};

// The settings from the setup view, checked against their definitions. base: the other settings.
const parseSetup = async (driver, dev, base, data = {}, repairing = false) => {
  const defs = settingDefs(driver);
  const values = data.settings || {};
  const settings = {};
  setupIds(driver, dev).forEach((id) => {
    const def = defs[id];
    if (!def || values[id] === undefined) return;
    if (def.type === 'checkbox') {
      settings[id] = !!values[id];
    } else if (def.type === 'dropdown') {
      if ((def.values || []).some((v) => v.id === String(values[id]))) settings[id] = String(values[id]);
    } else if (def.type === 'number') {
      let num = Number(values[id]);
      if (!Number.isFinite(num)) return;
      if (typeof def.min === 'number') num = Math.max(def.min, num);
      if (typeof def.max === 'number') num = Math.min(def.max, num);
      settings[id] = num;
    } else {
      settings[id] = String(values[id]).trim();
    }
  });
  const all = { ...base, ...settings };
  // The price comes from a price device in the tariff group (there is no fixed tariff setting).
  // Repair does not block: an older device without one shows a warning instead.
  if (!repairing && driver.ds.setup.requirePrice && !dapGroups(driver)[Number(all.tariff_update_group)]) {
    throw Error(driver.homey.__('error_setup_no_price'));
  }
  if (all.distribution) {
    const reason = Budget.invalidReason(all.distribution, all.budget);
    if (reason) throw Error(driver.homey.__(reason));
  }
  if (driver.setupValidate) await driver.setupValidate(all, data.caps || {}, dev);
  return settings;
};

/**
 * Pairing: the list, then the setup view, which creates the device.
 * @param {function} listDevices - the list_devices handler
 */
const registerPair = (driver, session, listDevices) => {
  let selected = null;
  session.setHandler('list_devices', listDevices);
  session.setHandler('list_devices_selection', (devices) => {
    [selected] = devices;
  });
  session.setHandler('setup_get', async () => {
    if (!selected || !selected.settings) throw Error(driver.homey.__('error_device_corrupt'));
    return getSetup(driver, selected, { settings: selected.settings, stored: null });
  });
  session.setHandler('setup_set', async (data = {}) => {
    if (!selected || !selected.settings) throw Error(driver.homey.__('error_device_corrupt'));
    const settings = { ...selected.settings, ...await parseSetup(driver, selected, selected.settings, data) };
    const store = { ...(selected.store || {}) };
    // The group's currency right away: else the first prices set it, with a restart during init.
    const moneyUnit = driver.moneyUnits && driver.moneyUnits[settings.tariff_update_group];
    if (moneyUnit) store[MoneyUnit.STORE_KEY] = moneyUnit;
    if (data.roleDeviceId) {
      storeRoles(driver, data.roleDeviceId, data.caps || {}, selected).forEach(({ key, value }) => {
        store[key] = value;
      });
    }
    const capabilities = driver.capabilitiesFor ? driver.capabilitiesFor(settings) : selected.capabilities;
    return {
      device: {
        ...selected, name: sourceName(driver, selected), settings, store, capabilities,
      },
    }; // the view creates it
  });
};

/**
 * Repairing: the list, the setup view when the driver has one, then the new settings.
 * @param {function} listDevices - the list_devices handler
 * @param {string[]} sourceIds - the settings that come with the listed source device
 */
const registerRepair = (driver, session, device, listDevices, sourceIds) => {
  driver.log('Repairing of device started', device.getName());
  let selectedDevices = [];
  let setup = null; // { settings, roles } from the setup view
  // The present source first (virtual sources get a new id per listing: same type then).
  const own = device.getSettings();
  const rank = (dev) => {
    const s = dev.settings || {};
    let score = 0;
    if (s.homey_device_id === own.homey_device_id) score = 2;
    else if (s.source_device_type && s.source_device_type !== 'Homey device'
      && s.source_device_type === own.source_device_type && s.homey_energy === own.homey_energy) score = 2;
    if (score && s.ev_device_id !== undefined && s.ev_device_id === own.ev_device_id) score += 1;
    return score;
  };
  session.setHandler('list_devices', async () => {
    const devices = await listDevices();
    return devices.map((dev, i) => ({ dev, i, r: rank(dev) }))
      .sort((a, b) => (b.r - a.r) || (a.i - b.i))
      .map(({ dev }) => dev);
  });
  session.setHandler('list_devices_selection', (devices) => {
    selectedDevices = devices;
  });
  // The device's own settings, with those of the newly listed source.
  const currentSettings = (dev) => ({ ...device.getSettings(), ...pick(dev.settings, sourceIds) });
  session.setHandler('setup_get', async () => {
    const [dev] = selectedDevices;
    if (!dev || !dev.settings) throw Error(driver.homey.__('error_device_corrupt'));
    return getSetup(driver, dev, { settings: currentSettings(dev), stored: storedRoles(driver, device), device });
  });
  session.setHandler('setup_set', async (data = {}) => {
    const [dev] = selectedDevices;
    if (!dev || !dev.settings) throw Error(driver.homey.__('error_device_corrupt'));
    const actionIds = driver.repairActions ? driver.repairActions(device).map((a) => a.id) : [];
    setup = {
      settings: await parseSetup(driver, dev, currentSettings(dev), data, true),
      roles: data.roleDeviceId ? { deviceId: data.roleDeviceId, caps: data.caps || {} } : null,
      actions: actionIds.filter((id) => (data.settings || {})[id] === true),
    };
    return {}; // the view continues to 'loading'
  });
  session.setHandler('showView', async (viewId) => {
    if (viewId !== 'loading') return;
    const [dev] = selectedDevices;
    if (!dev || !dev.settings) {
      await session.showView('done');
      throw Error(driver.homey.__('error_device_corrupt'));
    }
    const oldSettings = device.getSettings();
    const newSettings = { ...pick(dev.settings, sourceIds), ...(setup ? setup.settings : {}) };
    driver.log('old settings:', oldSettings);
    // The same follow-up as a change in the device settings (capabilities, tariff group, resets).
    const changedKeys = Object.keys(newSettings)
      .filter((id) => !sourceIds.includes(id) && newSettings[id] !== oldSettings[id]);
    // Like the settings page: a refused change is not saved.
    try {
      if (changedKeys.length) {
        await device.onSettings({ oldSettings, newSettings: { ...oldSettings, ...newSettings }, changedKeys });
      }
      await device.setSettings(newSettings);
      if (newSettings.homey_device_id !== oldSettings.homey_device_id && device.onSourceChanged) await device.onSourceChanged();
    } catch (err) {
      driver.error(err);
      await session.showView('done');
      throw err;
    }
    if (setup && setup.roles) {
      for (const { key, value } of storeRoles(driver, setup.roles.deviceId, setup.roles.caps, selectedDevices[0])) {
        await device.setStoreValue(key, value).catch((err) => driver.error(err));
      }
    }
    for (const id of (setup && setup.actions) || []) {
      await device.onRepairAction(id).catch((err) => driver.error(err));
    }
    await session.showView('done');
    driver.log('new settings:', device.getSettings());
    device.restartDevice().catch((err) => driver.error(err));
  });
  if (typeof device.fixValues === 'function') {
    session.setHandler('fix_get', async () => device.fixValues());
    session.setHandler('fix_set', async (data = {}) => device.applyFixValues(data));
  }
  session.setHandler('disconnect', () => {
    driver.log('Repairing of device ended', device.getName());
  });
};

module.exports = {
  text,
  settingDefs,
  listName,
  apiDevice,
  listScore,
  sortByScore,
  registerPair,
  registerRepair,
};
