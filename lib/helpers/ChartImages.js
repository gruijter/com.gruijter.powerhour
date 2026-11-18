/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./Util');
const { imageUrlToStream } = require('../charts/ImageHelpers');

async function registerChartImages(device, chartImages) {
  await setTimeoutPromise(Math.random() * 8000, device);

  for (const {
    id, prop, chartProp, titleKey,
  } of chartImages) {
    if (device[prop]) continue; // eslint-disable-line no-continue
    try {
      const image = await device.homey.images.createImage();
      image.setStream(async (stream) => imageUrlToStream(device[chartProp], stream, device));
      await device.setCameraImage(id, ` ${device.homey.__(titleKey)}`, image);
      device[prop] = image;
    } catch (err) {
      device.error(`Failed to register image ${id}`, err);
    }
    await setTimeoutPromise(300, device);
  }
}

module.exports = { registerChartImages };
