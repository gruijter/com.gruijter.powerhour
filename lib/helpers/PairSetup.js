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

// Pairing and repairing with the setup view (drivers/<id>/pair|repair/setup.html): the source
// device from the list, then a driver's key settings and, per role, the capability of a linked
// device to use. A driver opts in with ds.setup = { settings: [ids], preset: { id: value } } and
// can add:
//   setupSettings(dev)                         -> the setting ids for this listed device
//   setupInfo(setting, def, dev, current)      -> text under a setting
//   setupRoles(dev, stored)                    -> { deviceId, title, text, items } or null
//   setupStored(device) / setupStore(id, caps) -> the role choice in the device store
//   setupValidate(settings, caps, dev)         -> throws when the setup cannot work
//   capabilitiesFor(settings)                  -> the capabilities to pair with
// Without ds.setup, repair only replaces the source device.

// A translation object from the manifest in the language of Homey.
const text = (homey, t) => {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t[homey.i18n.getLanguage() || 'en'] || t.en || '';
};

// The driver settings from the manifest, by id.
const settingDefs = (driver) => {
  const manifest = driver.homey.app.manifest.drivers.find((d) => d.id === driver.ds.driverId) || {};
  const defs = {};
  const walk = (list) => (list || []).forEach((s) => {
    if (s.children) walk(s.children);
    else defs[s.id] = s;
  });
  walk(manifest.settings);
  return defs;
};

// The electricity DAP devices by tariff update group: { group: [names] }.
const dapGroups = (driver) => {
  const names = {};
  ['dap', 'dap15'].forEach((driverId) => {
    let devices = [];
    try {
      devices = driver.homey.drivers.getDriver(driverId).getDevices();
    } catch {
      return;
    }
    devices.forEach((dap) => {
      const group = Number(dap.getSettings().tariff_update_group);
      if (!group) return;
      (names[group] = names[group] || []).push(dap.getName());
    });
  });
  return names;
};

// Tariff update groups with the names of the DAP devices in them; without a DAP the present group.
const tariffGroupOptions = (driver, current) => {
  const names = dapGroups(driver);
  const groups = Object.keys(names).map(Number);
  if (!groups.length) groups.push(typeof current === 'number' ? current : 1);
  return groups.sort((a, b) => a - b)
    .map((group) => ({ id: group, label: `${group}${names[group] ? `: ${names[group].join(', ')}` : ''}` }));
};

// The setting ids to ask; the fixed tariff only without a DAP.
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

const setupIds = (driver, dev) => {
  const ids = driver.setupSettings ? driver.setupSettings(dev) : driver.ds.setup.settings;
  const hasDap = Object.keys(dapGroups(driver)).length > 0;
  return ids.filter((id) => id !== 'tariff' || !hasDap);
};

const storedRoles = (driver, device) => (driver.setupStored
  ? driver.setupStored(device) : device.getStoreValue('sourceCaps'));

const storeRoles = (driver, deviceId, caps) => (driver.setupStore
  ? driver.setupStore(deviceId, caps) : { key: 'sourceCaps', value: { sourceId: deviceId, caps } });

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
  const ids = setupIds(driver, dev);
  for (const id of ids.filter((i) => defs[i])) {
    const def = defs[id];
    let value = current.settings[id] !== undefined ? current.settings[id] : def.value;
    if (preset[id] !== undefined) value = preset[id];
    const setting = {
      id, type: def.type, label: text(homey, def.label), value, min: def.min, max: def.max,
    };
    if (def.type === 'dropdown') setting.options = (def.values || []).map((v) => ({ id: v.id, label: text(homey, v.label) }));
    if (id === 'tariff_update_group') {
      setting.type = 'dropdown';
      setting.options = tariffGroupOptions(driver, value);
      if (!setting.options.some((opt) => opt.id === value)) setting.value = setting.options[0].id;
      // Without a DAP: a fixed tariff (asked below) or flow, or for a charge plan a DAP fed by flow.
      if (!Object.keys(dapGroups(driver)).length) {
        setting.info = homey.__(ids.includes('tariff') ? 'repair.setup_no_dap' : 'repair.setup_no_dap_plan');
      }
    }
    if (driver.setupInfo) setting.info = (await driver.setupInfo(setting, def, dev, current)) || setting.info;
    settings.push(setting);
  }
  const roles = driver.setupRoles ? await driver.setupRoles(dev, current.stored) : null;
  return { title: dev.name, settings, roles };
};

// The settings from the setup view, checked against their definitions. base: the other settings.
const parseSetup = async (driver, dev, base, data = {}) => {
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
  if (all.distribution && all.distribution !== 'NONE') {
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
    // The group's currency right away: else the first prices set it, with a restart during init.
    const currency = driver.currencies && driver.currencies[settings.tariff_update_group];
    if (currency) settings.currency = currency;
    const store = { ...(selected.store || {}) };
    if (data.roleDeviceId) {
      const { key, value } = storeRoles(driver, data.roleDeviceId, data.caps || {});
      store[key] = value;
    }
    const capabilities = driver.capabilitiesFor ? driver.capabilitiesFor(settings) : selected.capabilities;
    return {
      device: {
        ...selected, settings, store, capabilities,
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
    setup = {
      settings: await parseSetup(driver, dev, currentSettings(dev), data),
      roles: data.roleDeviceId ? { deviceId: data.roleDeviceId, caps: data.caps || {} } : null,
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
    if (changedKeys.length) {
      await device.onSettings({ oldSettings, newSettings: { ...oldSettings, ...newSettings }, changedKeys })
        .catch((err) => driver.error(err));
    }
    await device.setSettings(newSettings).catch((err) => driver.error(err));
    if (setup && setup.roles) {
      const { key, value } = storeRoles(driver, setup.roles.deviceId, setup.roles.caps);
      await device.setStoreValue(key, value).catch((err) => driver.error(err));
    }
    await session.showView('done');
    driver.log('new settings:', device.getSettings());
    device.restartDevice().catch((err) => driver.error(err));
  });
  session.setHandler('disconnect', () => {
    driver.log('Repairing of device ended', device.getName());
  });
};

module.exports = {
  text,
  listScore,
  sortByScore,
  registerPair,
  registerRepair,
};
