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

const { Readable } = require('stream');

const imageCache = [];

const imageUrlToStream = async (input, stream, context) => {
  const isUrl = typeof input === 'string';
  const cacheKey = isUrl ? input : JSON.stringify(input);

  // check if key is in cache
  let cacheObject = imageCache.find((object) => object.key === cacheKey);
  if (cacheObject) {
    const readable = Readable.from(cacheObject.buffer);
    return readable.pipe(stream);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeoutId;
  const useHomey = context && context.homey && context.homey.setTimeout;

  if (useHomey) {
    timeoutId = context.homey.setTimeout(abort, 10000);
  } else {
    timeoutId = setTimeout(abort, 10000);
  }

  let res;
  try {
    if (context && context.log) context.log('[ImageHelpers] Fetch start. isUrl:', isUrl);
    if (isUrl) {
      res = await fetch(input, { signal: controller.signal });
    } else {
      res = await fetch('https://quickchart.io/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cacheKey, // cacheKey is the stringified JSON config
        signal: controller.signal,
      });
    }
    if (context && context.log) context.log('[ImageHelpers] Fetch done. Status:', res.status, res.statusText);
  } catch (err) {
    if (context && context.error) context.error('[ImageHelpers] Fetch failed:', err);
    throw err;
  } finally {
    if (useHomey) context.homey.clearTimeout(timeoutId);
    else clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const errBody = await res.text();
    if (context && context.error) context.error('[ImageHelpers] Response not OK:', errBody);
    throw new Error(`Invalid Response: ${res.status} ${res.statusText} - ${errBody.substring(0, 200)}`);
  }
  const body = await res.arrayBuffer();
  cacheObject = { key: cacheKey, buffer: Buffer.from(body) };
  imageCache.push(cacheObject);
  if (imageCache.length > 5) {
    imageCache.shift();
  }
  const readable = Readable.from(cacheObject.buffer);
  return readable.pipe(stream);
};

module.exports = {
  imageUrlToStream,
};
