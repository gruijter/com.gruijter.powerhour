/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const setTimeoutPromise = (delay) => new Promise((resolve) => {
  setTimeout(resolve, delay);
});

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
          await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
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
        await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
        device.currencyChanged = true;
      }
    }
    return true;
  },
};
