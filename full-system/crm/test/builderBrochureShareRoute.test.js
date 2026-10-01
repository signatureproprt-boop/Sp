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
    new URL(`https://example.com/signature-properties/different-project/brochure/${token}`));
  assert.equal(wrongProject.status, 404);
});
