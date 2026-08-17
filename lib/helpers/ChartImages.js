/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./Util');
const { imageUrlToStream } = require('../charts/ImageHelpers');

// Camera images are created lazily and their display order is fixed the moment each is first
// registered via setCameraImage() - Homey has no capability to reorder or remove them afterward.
// Confirmed empirically (2026-08-17, live against a real device): images are NOT capabilities
// (invisible to hasCapability()/getCapabilities() - this module is deliberately not named
// "capabilities" anywhere, to avoid repeating that exact confusion), they don't persist
// independently of the app process (a restart clears and freshly recreates all of them), and
// recreating one under an existing id appends it to the end of the list rather than restoring
// its position. So there is no "wrong order to detect and fix" at runtime - the only lever is
// registering them in the right order in the first place, every boot, before any chart content
// exists yet.
//
// chartImages: array (order = canonical display order) of
//   { id, prop, chartProp, titleKey }
//   - id: the camera image id passed to setCameraImage()
//   - prop: device instance property that will hold the Image object
//   - chartProp: device instance property holding the current chart-spec object (set later by
//     the driver's own chart-generation code) that the lazy stream reads
//   - titleKey: i18n key passed to device.homey.__()
async function registerChartImages(device, chartImages) {
  // Stagger this device's whole registration burst against other devices booting at the same
  // time - same jitter idiom already used app-wide for boot-time work (e.g.
  // generic_bat_driver.js's `Math.random() * 8000` hourly-listener registration).
  await setTimeoutPromise(Math.random() * 8000, device);

  for (const {
    id, prop, chartProp, titleKey,
  } of chartImages) {
    if (device[prop]) continue; // eslint-disable-line no-continue
    try {
      // Only commit to device[prop] once fully registered - if setCameraImage() throws partway
      // through, leaving device[prop] set would make the `if (device[prop]) continue` guard
      // above skip retrying this one for the rest of this process's lifetime (e.g. across a
      // restartDevice() that re-runs onInit() on the same instance without a fresh process).
      const image = await device.homey.images.createImage();
      image.setStream(async (stream) => imageUrlToStream(device[chartProp], stream, device));
      await device.setCameraImage(id, ` ${device.homey.__(titleKey)}`, image);
      device[prop] = image;
    } catch (err) {
      device.error(`Failed to register image ${id}`, err);
    }
    // Small pacing delay between each of this device's own images - registration itself is
    // cheap (no chart rendering happens here), but avoids a tight synchronous burst of
    // image-manager calls.
    await setTimeoutPromise(300, device);
  }
}

module.exports = { registerChartImages };
