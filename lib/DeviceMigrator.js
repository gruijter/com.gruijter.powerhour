/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const SETTLE_MS = 1 * 1000;

const settle = (device, ms) => (ms > 0
  ? new Promise((resolve) => {
    device.homey.setTimeout(resolve, ms);
  })
  : Promise.resolve());

const running = new WeakMap();

const restorable = (device, cap, value) => {
  const app = (device.homey && device.homey.app && device.homey.app.manifest) || {};
  const definition = (app.capabilities || {})[cap.split('.')[0]] || {};
  const options = ((device.driver && device.driver.manifest && device.driver.manifest.capabilitiesOptions) || {})[cap] || {};
  const values = options.values || definition.values;
  if (!Array.isArray(values)) return true;
  return values.some((v) => v.id === value);
};

const migrate = async (device, correctCaps, { settleMs, shouldAbort, unavailableMessage }) => {
  if (!Array.isArray(correctCaps)) throw Error(`No capability list to migrate ${device.getName()} to`);
  const wanted = [...new Set(correctCaps.filter(Boolean))];

  const caps = device.getCapabilities();
  const maxLen = Math.max(caps.length, wanted.length);
  let firstMismatch = 0;
  while (firstMismatch < maxLen && caps[firstMismatch] === wanted[firstMismatch]) firstMismatch += 1;
  if (firstMismatch === maxLen) return false;

  const keep = new Set(wanted);
  const dropped = caps.filter((cap) => !keep.has(cap));
  const kept = caps.filter((cap) => keep.has(cap));
  let rebuildFrom = 0;
  while (rebuildFrom < kept.length && kept[rebuildFrom] === wanted[rebuildFrom]) rebuildFrom += 1;
  const toRemove = [...dropped, ...kept.slice(rebuildFrom)];
  const toAdd = wanted.slice(rebuildFrom);

  device.log(`migrating capabilities for ${device.getName()}: removing`, toRemove, 'adding', toAdd);
  const state = {};
  caps.forEach((cap) => {
    state[cap] = device.getCapabilityValue(cap);
  });
  const wasAvailable = device.getAvailable();
  if (wasAvailable) await device.setUnavailable(unavailableMessage || device.homey.__('migrating')).catch((error) => device.error(error));

  try {
    for (const cap of toRemove) {
      if (shouldAbort && shouldAbort()) return true;
      if (!device.hasCapability(cap)) continue;
      device.log(`removing capability ${cap}`);
      // eslint-disable-next-line no-await-in-loop
      await device.removeCapability(cap).catch((error) => device.error(error));
      // eslint-disable-next-line no-await-in-loop
      await settle(device, settleMs);
    }

    for (const cap of toAdd) {
      if (shouldAbort && shouldAbort()) return true;
      if (!device.hasCapability(cap)) {
        device.log(`adding capability ${cap}`);
        // eslint-disable-next-line no-await-in-loop
        await device.addCapability(cap).catch((error) => device.error(error));
        // eslint-disable-next-line no-await-in-loop
        await settle(device, settleMs);
      }
      if (state[cap] === undefined || state[cap] === null || !restorable(device, cap, state[cap])) continue;
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityValue(cap, state[cap]).catch((error) => device.error(error));
    }
  } finally {
    if (wasAvailable) await device.setAvailable().catch((error) => device.error(error));
  }
  return true;
};

const sameOption = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameOption(a[key], b[key]));
};

module.exports = {

  async migrateCapabilities(device, correctCaps, { settleMs = SETTLE_MS, shouldAbort, unavailableMessage } = {}) {
    const previous = running.get(device) || Promise.resolve();
    const job = previous.catch(() => null).then(() => migrate(device, correctCaps, { settleMs, shouldAbort, unavailableMessage }));
    running.set(device, job);
    try {
      return await job;
    } finally {
      if (running.get(device) === job) running.delete(device);
    }
  },

  async migrateClass(device, wantedClass = device.driver.manifest.class) {
    const current = device.getClass();
    if (!wantedClass || current === wantedClass) return false;
    device.log(`migrating device class for ${device.getName()}: ${current} -> ${wantedClass}`);
    await device.setClass(wantedClass);
    return true;
  },

  async migrateEnergy(device, wantedEnergy = device.driver.manifest.energy) {
    if (!wantedEnergy) return false;
    const current = device.getEnergy();
    if (sameOption(current, wantedEnergy)) return false;
    device.log(`migrating energy for ${device.getName()}:`, JSON.stringify(current), '->', JSON.stringify(wantedEnergy));
    await device.setEnergy(wantedEnergy);
    return true;
  },

  async syncCapabilityOptions(device, wanted, { force = false } = {}) {
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    for (const [cap, options] of Object.entries(wanted)) {
      if (!device.hasCapability(cap)) continue;
      let current = {};
      try {
        current = force ? {} : device.getCapabilityOptions(cap) || {};
      } catch {
        const app = (device.homey && device.homey.app && device.homey.app.manifest) || {};
        const definition = (app.capabilities || {})[cap.split('.')[0]] || {};
        current = { ...definition, ...(manifestOptions[cap] || {}) };
      }
      if (Object.entries(options).every(([key, value]) => sameOption(current[key], value))) continue;
      device.log(`capability options for ${cap}:`, JSON.stringify(options));
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityOptions(cap, { ...(manifestOptions[cap] || {}), ...options })
        .catch((error) => device.error(error));
    }
  },

};
