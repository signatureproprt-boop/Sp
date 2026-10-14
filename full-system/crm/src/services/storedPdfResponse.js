'use strict';

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function sendStoredPdf(res, buffer, method, headers = {}) {
  const responseHeaders = { ...headers, 'Content-Type': 'application/pdf' };
  delete responseHeaders['Content-Length'];
  if (method === 'HEAD') {
    responseHeaders['Content-Length'] = buffer.length;
    res.writeHead(200, responseHeaders);
    res.end();
    return;
  }
  // Cloud Run limits non-streamed HTTP/1 responses to 32 MiB. Explicit
  // chunking also prevents Node from adding Content-Length on res.end(buffer).
  responseHeaders['Transfer-Encoding'] = 'chunked';
  res.writeHead(200, responseHeaders);
  function* chunks() {
    for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
      yield buffer.subarray(offset, offset + 64 * 1024);
    }
  }
  try {
    await pipeline(Readable.from(chunks()), res);
  } catch (error) {
    // A closed download cannot receive a JSON error after PDF headers.
    if (!res.destroyed) res.destroy(error);
  }
}

module.exports = { sendStoredPdf };
