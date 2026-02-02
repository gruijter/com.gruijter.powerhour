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

const imageUrlToStream = async (url, stream) => {
  // check if url is in cache
  let cacheObject = imageCache.find((object) => object.url === url);
  if (cacheObject) {
    const readable = Readable.from(cacheObject.buffer);
    return readable.pipe(stream);
  }

  const res = await fetch(url, { timeout: 10000 });
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
