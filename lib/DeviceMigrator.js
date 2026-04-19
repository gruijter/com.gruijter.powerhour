/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./Util');

module.exports = {
  async migrateCapabilities(device, correctCaps) {
    const currentSessionId = device.sessionId;
    device.log(`checking device migration for ${device.getName()}`);

    // store the capability states before migration
    const sym = Object.getOwnPropertySymbols(device).find((s) => String(s) === 'Symbol(state)');
    const state = { ...device[sym] };

    for (let index = 0; index < correctCaps.length; index += 1) {
      if (device.sessionId !== currentSessionId) return false;
      const caps = device.getCapabilities();
      const newCap = correctCaps[index];

      if (caps[index] !== newCap) {
        device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

        // remove all caps from here
        for (let i = index; i < caps.length; i += 1) {
          if (device.sessionId !== currentSessionId) return false;
          device.log(`removing capability ${caps[i]} for ${device.getName()}`);
          await device.removeCapability(caps[i]).catch((err) => device.error(err));
          await setTimeoutPromise(2 * 1000, device); // wait a bit for Homey to settle
        }

        // add the new cap
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap).catch((err) => device.error(err));

        // restore capability state
        if (state[newCap] !== undefined) {
          device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        } else {
          device.log(`${device.getName()} no value to restore for new capability ${newCap}, ${state[newCap]}!`);
        }
        await device.setCapability(newCap, state[newCap]);
        await setTimeoutPromise(2 * 1000, device); // wait a bit for Homey to settle
        device.currencyChanged = true;
      }
    }
    return true;
  },

  async checkCurrencyMismatch(device, targetCurrency, defaultCurrency = '¤', targetCapability = 'meter_tariff') {
    try {
      if (!device.currencyChanged && device.hasCapability(targetCapability)) {
        const opts = device.getCapabilityOptions(targetCapability);
        let currency = targetCurrency;
        if (!currency || currency === '') currency = defaultCurrency;
        if (opts && opts.units && opts.units.en !== currency) {
          device.log(`Currency mismatch detected at boot (is: ${opts.units.en}, should be: ${currency}). Forcing migration.`);
          device.currencyChanged = true;
        }
      }
    } catch (e) {
      // ignore
    }
  },

  async migrateCurrencyOptions(device, currency, decimals, defaultCurrency = '¤', currencyUnit = null) {
    device.log('migrating money capability options via DeviceMigrator');
    device.migrating = true;
    device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

    let curr = currency;
    let dec = decimals;
    if (!currency || currency === '') curr = defaultCurrency;
    if (!Number.isInteger(decimals)) dec = 2;

    const allCaps = device.driver.ds.deviceCapabilities || [];

    // 1. Standard money/price caps
    let standardCaps = [];
    if (currencyUnit) {
      standardCaps = allCaps.filter((name) => name.includes('money') && !name.includes('_avg'));
    } else if (allCaps.some((name) => name.includes('meter_price'))) {
      standardCaps = allCaps.filter((name) => name.includes('meter_price'));
    } else {
      standardCaps = allCaps.filter((name) => name.includes('meter_money'));
    }

    for (let i = 0; i < standardCaps.length; i += 1) {
      if (device.hasCapability(standardCaps[i])) {
        device.log(`migrating ${standardCaps[i]} to use ${curr} and ${dec} decimals`);
        await device.setCapabilityOptions(standardCaps[i], { units: { en: curr }, decimals: dec }).catch((err) => device.error(err));
        await setTimeoutPromise(1000, device);
      }
    }

    // 2. Tariff cap
    if (device.hasCapability('meter_tariff')) {
      device.log('migrating meter_tariff units and decimals');
      await device.setCapabilityOptions('meter_tariff', { units: { en: curr }, decimals: 4 }).catch((err) => device.error(err));
      await setTimeoutPromise(1000, device);
    }

    // 3. Avg caps
    if (currencyUnit) {
      const avgCaps = allCaps.filter((name) => name.includes('money') && name.includes('_avg'));
      for (let i = 0; i < avgCaps.length; i += 1) {
        if (device.hasCapability(avgCaps[i])) {
          device.log(`migrating avg units and decimals for ${avgCaps[i]}`);
          await device.setCapabilityOptions(avgCaps[i], { units: { en: `${curr}/${currencyUnit}` }, decimals: 4 }).catch((err) => device.error(err));
          await setTimeoutPromise(1000, device);
        }
      }
    }

    device.currencyChanged = false;
    device.migrating = false;
  },

  async migrateMeterOptions(device, decimals) {
    device.log('migrating meter capability options via DeviceMigrator');
    device.migrating = true;
    device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

    let dec = decimals;
    if (!Number.isInteger(decimals)) dec = 4;

    const allCaps = device.driver.ds.deviceCapabilities || [];

    const processCaps = async (caps, opts) => {
      for (let i = 0; i < caps.length; i += 1) {
        if (device.hasCapability(caps[i])) {
          device.log(`migrating decimals for ${caps[i]}`);
          await device.setCapabilityOptions(caps[i], opts).catch((err) => device.error(err));
          await setTimeoutPromise(1000, device);
        }
      }
    };

    const capsKWh = allCaps.filter((name) => name.includes('meter_kwh') || name.startsWith('meter_power'));
    const capsM3 = allCaps.filter((name) => name.includes('meter_m3') || name.startsWith('meter_gas') || name.startsWith('meter_water'));

    await processCaps(capsKWh, { units: { en: 'kWh' }, decimals: dec });
    await processCaps(capsM3, { units: { en: 'm³' }, decimals: dec });

    device.meterDecimalsChanged = false;
    device.migrating = false;
    device.log('meter capability options migration ready');
  },
};
