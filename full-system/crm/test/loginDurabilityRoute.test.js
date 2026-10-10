'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server');
const mongoStore = require('../src/data/mongoStore');

test('login sends its cookie only after the small durable save and never waits on the snapshot queue', async () => {
  const oldMode = mongoStore.isEnabled;
  const oldInitialized = mongoStore.isInitialized;
  const oldSecret = process.env.AUTH_TEST_SECRET;
  const oldNodeEnv = process.env.NODE_ENV;
  let acknowledge;
  const saved = new Promise(resolve => { acknowledge = resolve; });
  let flushes = 0;
  const user = { UserID: 'U-1', Status: 'ACTIVE', Role: 'ADMIN', CompanyID: 'C', BrokerageID: 'B' };
  const res = {
    __sigRequireMongoDurability: true, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; }
  };
  try {
    mongoStore.isEnabled = () => true;
    mongoStore.isInitialized = () => true;
    process.env.NODE_ENV = 'test'; process.env.AUTH_TEST_SECRET = 'test-only-secret';
    __test.setRuntimeForTest({
      repository: { listUsers: () => [user], getSettings: () => ({}), flush: () => { flushes++; return new Promise(() => {}); } },
      auth: { issueDurableSession: async (identity, store) => {
        assert.equal(identity.userId, 'U-1'); assert.ok(store);
        await saved;
        return 'ds_' + 'a'.repeat(48);
      } }
    }, { handle: async () => ({ handled: false }) });
    const pending = __test.handleApi({ method: 'POST', headers: { host: 'localhost' },
      _parsedBody: { userId: 'U-1', secret: 'test-only-secret' } }, res,
      new URL('http://localhost/api/auth/test-session'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.body, undefined);
    assert.equal(res.headers['Set-Cookie'], undefined);
    acknowledge(); await pending;
    assert.equal(res.status, 200);
    assert.match(res.headers['Set-Cookie'], /sig_dashboard_session=ds_/);
    assert.equal(flushes, 0);
  } finally {
    mongoStore.isEnabled = oldMode; mongoStore.isInitialized = oldInitialized;
    if (oldSecret === undefined) delete process.env.AUTH_TEST_SECRET; else process.env.AUTH_TEST_SECRET = oldSecret;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  }
});
