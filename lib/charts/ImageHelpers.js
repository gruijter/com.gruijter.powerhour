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

const imageUrlToStream = async (url, stream, context) => {
  // check if url is in cache
  let cacheObject = imageCache.find((object) => object.url === url);
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
    res = await fetch(url, { signal: controller.signal });
  } finally {
    if (useHomey) context.homey.clearTimeout(timeoutId);
    else clearTimeout(timeoutId);
  }
  if (!res.ok) {
    throw new Error('Invalid Response');
  }
  const body = await res.arrayBuffer();
  cacheObject = { url, buffer: Buffer.from(body) };
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
