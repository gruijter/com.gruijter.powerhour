/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./Util');
const { imageUrlToStream } = require('../charts/ImageHelpers');

// Camera images are not capabilities (skill section 7): their order is fixed when first registered
// via setCameraImage(), they are recreated on every app start, and a re-created id goes to the end.
// So they are registered in canonical order at every boot, before any chart content exists.
//
// chartImages: array in display order of { id, prop, chartProp, titleKey }
//   - id: the camera image id passed to setCameraImage()
//   - prop: device property that holds the Image object
//   - chartProp: device property with the chart spec the lazy stream reads
//   - titleKey: i18n key passed to device.homey.__()
async function registerChartImages(device, chartImages) {
  // Jitter against other devices booting at the same time
  await setTimeoutPromise(Math.random() * 8000, device);

  for (const {
    id, prop, chartProp, titleKey,
  } of chartImages) {
    if (device[prop]) continue; // eslint-disable-line no-continue
    try {
      // device[prop] only once fully registered, so a failed one is retried.
      const image = await device.homey.images.createImage();
      image.setStream(async (stream) => imageUrlToStream(device[chartProp], stream, device));
      await device.setCameraImage(id, ` ${device.homey.__(titleKey)}`, image);
      device[prop] = image;
    } catch (err) {
      device.error(`Failed to register image ${id}`, err);
    }
    // Short pause between this device's images
    await setTimeoutPromise(300, device);
  }
}

module.exports = { registerChartImages };
