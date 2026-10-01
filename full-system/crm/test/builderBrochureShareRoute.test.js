'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { __test } = require('../server');

function response() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

test('public brochure links reject unknown and expired tokens without exposing PDFs', async () => {
  const token = 'a'.repeat(64);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  let rows = [];
  __test.setRuntimeForTest({ repository: {
    find(collection, field, value) {
      assert.equal(collection, 'BuilderBrochureShares');
      assert.equal(field, 'TokenHash');
      return rows.find(row => row.TokenHash === value) || null;
    }
  } });
  const url = new URL(`https://example.com/api/v2/brochure-shares/${token}`);
  const req = { method: 'GET', headers: {} };
  const missing = response();
  await __test.handleApi(req, missing, url);
  assert.equal(missing.status, 404);
  rows = [{ TokenHash: hash, ProjectID: 'P1', ExpiresAt: '2000-01-01T00:00:00Z' }];
  const expired = response();
  await __test.handleApi(req, expired, url);
  assert.equal(expired.status, 404);
  rows = [{ TokenHash: hash, ProjectID: 'P1', ProjectSlug: 'vesu-heights', ExpiresAt: '2099-01-01T00:00:00Z' }];
  const wrongProject = response();
  await __test.handleApi(req, wrongProject,
    new URL(`https://signatureproperties.cloud.run/brochure/different-project/${token}`));
  assert.equal(wrongProject.status, 404);
});

test('recipient tracking requires a name, phone and explicit share channel', () => {
  const normalize = __test.normalizeBrochureRecipient;
  assert.deepEqual(normalize({ recipientName: '  Asha   Shah ', recipientPhone: '+91 98765 43210', channel: 'whatsapp_text' }),
    { name: 'Asha Shah', phone: '919876543210', channel: 'whatsapp_text' });
  assert.equal(normalize({ recipientName: 'Asha', recipientPhone: 'no phone', channel: 'whatsapp_text' }), null);
  assert.equal(normalize({ recipientName: '', recipientPhone: '9876543210', channel: 'pdf_share' }), null);
  assert.equal(normalize({ recipientName: 'Asha', recipientPhone: '9876543210', channel: 'unknown' }), null);
});
