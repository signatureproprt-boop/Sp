'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { openPdfStreamSafely } = require('../src/services/safeUrlDownloader');

test('uncapped brochure stream accepts a PDF above the old 20 MB limit', async () => {
  const bytes = 21 * 1024 * 1024;
  const server = http.createServer(async (_request, response) => {
    response.setHeader('Content-Length', bytes);
    response.write('%PDF-1.7\n');
    const chunk = Buffer.alloc(64 * 1024);
    let remaining = bytes - 9;
    while (remaining > 0) {
      const n = Math.min(chunk.length, remaining);
      if (!response.write(chunk.subarray(0, n))) await once(response, 'drain');
      remaining -= n;
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await openPdfStreamSafely(`http://127.0.0.1:${server.address().port}/brochure.pdf`, { maxBytes: Infinity, allowPrivateNetworks: true });
    assert.equal(result.ok, true, result.error);
    let total = 0;
    for await (const chunk of result.stream) total += chunk.length;
    assert.equal(total, bytes);
  } finally {
    server.close();
  }
});
