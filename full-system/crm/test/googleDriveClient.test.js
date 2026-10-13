'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');
const {
  createBufferStream,
  createDriveAuth,
  createGoogleDriveClient,
  driveRequestTimeoutMs,
  DEFAULT_DRIVE_REQUEST_TIMEOUT_MS
} = require('../src/services/googleDriveClient');

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

test('Google Drive folder creation and media uploads have a bounded request timeout', async () => {
  const calls = [];
  const client = createGoogleDriveClient({
    env: { SIG_REALTY_GOOGLE_DRIVE_TIMEOUT_MS: '45000' },
    driveFactory: () => ({
      files: {
        create: async (params, options) => {
          calls.push({ params, options });
          return { data: { id: `file-${calls.length}`, name: params.requestBody.name } };
        }
      }
    })
  });

  await client.createFolder('Project folder', 'parent-id');
  await client.uploadBuffer('photo.jpg', Buffer.from('image'), 'folder-id', 'image/jpeg');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options.timeout), [45000, 45000]);
  assert.equal(calls[0].params.requestBody.mimeType, 'application/vnd.google-apps.folder');
  assert.equal(calls[1].params.media.mimeType, 'image/jpeg');
});

test('Google Drive folder lookup is scoped to exact parent and name', async () => {
  const calls = [];
  const client = createGoogleDriveClient({
    env: {},
    driveFactory: () => ({ files: { list: async (params, options) => {
      calls.push({ params, options });
      return { data: { files: [{ id: 'existing-folder', name: "Owner's brochure" }] } };
    } } })
  });
  const folder = await client.findFolder("Owner's brochure", 'parent-id');
  assert.equal(folder.id, 'existing-folder');
  assert.match(calls[0].params.q, /name = 'Owner\\'s brochure'/);
  assert.match(calls[0].params.q, /'parent-id' in parents/);
  assert.equal(calls[0].params.orderBy, 'createdTime asc');
  assert.equal(calls[0].options.timeout, DEFAULT_DRIVE_REQUEST_TIMEOUT_MS);
});

test('Google Drive request timeout defaults safely and is capped', () => {
  assert.equal(driveRequestTimeoutMs({}), DEFAULT_DRIVE_REQUEST_TIMEOUT_MS);
  assert.equal(driveRequestTimeoutMs({ SIG_REALTY_GOOGLE_DRIVE_TIMEOUT_MS: 'invalid' }), DEFAULT_DRIVE_REQUEST_TIMEOUT_MS);
  assert.equal(driveRequestTimeoutMs({ SIG_REALTY_GOOGLE_DRIVE_TIMEOUT_MS: '999999' }), 120000);
});
