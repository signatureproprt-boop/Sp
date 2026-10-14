'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { sendStoredPdf } = require('../src/services/storedPdfResponse');

test('a PDF larger than Cloud Run buffered limit is chunked with unchanged bytes; HEAD is bodyless', async () => {
  const pdf = Buffer.alloc(33 * 1024 * 1024, 42);
  pdf.write('%PDF-1.7\n');
  const server = http.createServer((req, res) => {
    void sendStoredPdf(res, pdf, req.method, {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline; filename="selected-brochure.pdf"'
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = method => new Promise((resolve, reject) => {
      const req = http.request({host:'127.0.0.1',port:server.address().port,method}, res => {
        const hash = createHash('sha256'); let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({status:res.statusCode,headers:res.headers,bytes,hash:hash.digest('hex')}));
      });
      req.on('error', reject); req.end();
    });
    const get = await request('GET');
    assert.equal(get.status, 200);
    assert.equal(get.headers['transfer-encoding'], 'chunked');
    assert.equal(get.headers['content-length'], undefined);
    assert.equal(get.bytes, pdf.length);
    assert.equal(get.hash, createHash('sha256').update(pdf).digest('hex'));
    assert.equal(get.headers['cache-control'], 'private, no-store');
    assert.equal(get.headers['content-type'], 'application/pdf');
    const head = await request('HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.bytes, 0);
    assert.equal(Number(head.headers['content-length']), pdf.length);
    assert.equal(head.headers['transfer-encoding'], undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
