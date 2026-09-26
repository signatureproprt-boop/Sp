'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');
const { createBufferStream, createDriveAuth } = require('../src/services/googleDriveClient');

test('Google Drive upload stream preserves a Buffer as one binary chunk', async () => {
  const payload = Buffer.from([0, 1, 127, 128, 255]);
  const chunks = [];
  for await (const chunk of createBufferStream(payload)) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.ok(Buffer.isBuffer(chunks[0]));
  assert.deepEqual(chunks[0], payload);
});


test('Google Drive auth uses the configured user refresh token', () => {
  const auth = createDriveAuth({
    SIG_REALTY_GOOGLE_CLIENT_ID: 'client-id',
    SIG_REALTY_GOOGLE_CLIENT_SECRET: 'client-secret',
    SIG_REALTY_GOOGLE_REFRESH_TOKEN: 'refresh-token'
  });

  assert.ok(auth instanceof google.auth.OAuth2);
  assert.equal(auth.credentials.refresh_token, 'refresh-token');
});

test('Google Drive auth rejects incomplete OAuth config instead of silently using a service account', () => {
  assert.throws(
    () => createDriveAuth({
      SIG_REALTY_GOOGLE_CLIENT_ID: 'client-id',
      SIG_REALTY_GOOGLE_CLIENT_SECRET: 'client-secret'
    }),
    /SIG_REALTY_GOOGLE_REFRESH_TOKEN must all be set/
  );
});

test('Google Drive auth uses ADC only when no OAuth credentials are configured', () => {
  const auth = createDriveAuth({});
  assert.ok(auth instanceof google.auth.GoogleAuth);
});
