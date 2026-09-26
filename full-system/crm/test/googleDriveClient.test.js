'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBufferStream } = require('../src/services/googleDriveClient');

test('Google Drive upload stream preserves a Buffer as one binary chunk', async () => {
  const payload = Buffer.from([0, 1, 127, 128, 255]);
  const chunks = [];
  for await (const chunk of createBufferStream(payload)) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.ok(Buffer.isBuffer(chunks[0]));
  assert.deepEqual(chunks[0], payload);
});
