const { Readable } = require('stream');
const fetch = require('node-fetch');

const imageCache = [];

const imageUrlToStream = async (url, stream) => {
    // check if url is in cache
    let cacheObject = imageCache.find(object => object.url === url);
    if (cacheObject) {
        const readable = Readable.from(cacheObject.buffer);
        return readable.pipe(stream);
    }

    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
        throw new Error("Invalid Response");
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