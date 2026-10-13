'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, SESSION_COOKIE_NAME } = require('../src/services/authService');
const { MongoSessionStore } = require('../src/data/mongoSessionStore');

function fixture() {
  const rows = new Map();
  const calls = [];
  let fail = false;
  const collection = {
    async createIndex(keys, options) { calls.push(['index', keys, options]); },
    async replaceOne(filter, row, options) {
      calls.push(['save', filter, options]);
      if (fail) throw new Error('network failure');
      rows.set(filter._id, row);
      return { acknowledged: true };
    },
    async findOne(filter, options) {
      calls.push(['read', filter, options]);
      if (fail) throw new Error('network failure');
      return rows.get(filter._id) || null;
    },
    async deleteOne(filter, options) {
      calls.push(['delete', filter, options]);
      if (fail) throw new Error('network failure');
      rows.delete(filter._id);
      return { acknowledged: true };
    }
  };
  const db = { collection: name => { assert.equal(name, 'auth_sessions'); return collection; } };
  const store = new MongoSessionStore(() => db);
  const user = { UserID: 'U-1', Status: 'ACTIVE', Role: 'ADMIN', CompanyID: 'C-1', BrokerageID: 'B-1', Permissions: ['*'] };
  const repo = {
    getUser: () => user, getSettings: () => ({}), getRole: () => null,
    // A dedicated login must never enqueue the large snapshot.
    upsertSession: () => { throw new Error('snapshot queue is stuck'); },
    deleteSession: () => { throw new Error('snapshot queue is stuck'); },
    getSession: () => { throw new Error('dedicated sessions must not fall back to snapshots'); }
  };
  return { store, rows, calls, user, auth: () => new AuthService(repo), setFail: value => { fail = value; } };
}
function request(token) {
  return { pathname: '/api/auth/me', headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } };
}

test('durable login works with a stuck snapshot queue and survives an instance restart', async () => {
  const f = fixture();
  const first = f.auth();
  const token = await first.issueDurableSession({ userId: 'U-1' }, f.store);
  assert.match(token, /^ds_[a-f0-9]{48}$/);
  const second = f.auth();
  await second.prepareRequest(request(token), f.store);
  assert.equal(second.resolveRequestContext(request(token)).authenticated, true);
  assert.equal(f.rows.size, 1);
  const [row] = f.rows.values();
  assert.equal(row.data.sessionId, undefined);
  assert.notEqual(row._id, token);
  assert.equal(f.calls.find(c => c[0] === 'save')[2].writeConcern.w, 'majority');
  assert.equal(f.calls.find(c => c[0] === 'read')[2].timeoutMS, 10000);
});

test('failed durable save does not issue a usable in-memory session', async () => {
  const f = fixture(); f.setFail(true);
  const auth = f.auth();
  await assert.rejects(auth.issueDurableSession({ userId: 'U-1' }, f.store), { statusCode: 503 });
  assert.equal(auth.sessions.size, 0);
  assert.equal(f.rows.size, 0);
});

test('logout on one instance invalidates the cached session on another', async () => {
  const f = fixture(); const first = f.auth(); const second = f.auth();
  const token = await first.issueDurableSession({ userId: 'U-1' }, f.store);
  await second.prepareRequest(request(token), f.store);
  await first.revokeDurableSession(token, f.store);
  await second.prepareRequest(request(token), f.store);
  assert.equal(second.resolveRequestContext(request(token)).authenticated, false);
});

test('read outage fails closed even if this instance previously cached the session', async () => {
  const f = fixture(); const auth = f.auth();
  const token = await auth.issueDurableSession({ userId: 'U-1' }, f.store);
  f.setFail(true);
  await assert.rejects(auth.prepareRequest(request(token), f.store), { statusCode: 503 });
  assert.equal(auth.resolveRequestContext(request(token)).authenticated, false);
});

test('expired durable sessions and changed user permissions are enforced', async () => {
  const f = fixture(); const auth = f.auth();
  const token = await auth.issueDurableSession({ userId: 'U-1' }, f.store);
  f.user.Role = 'VIEWER'; f.user.Permissions = [];
  await auth.prepareRequest(request(token), f.store);
  assert.equal(auth.resolveRequestContext(request(token)).role, 'VIEWER');
  const [row] = f.rows.values(); row.expiresAt = new Date(0);
  await auth.prepareRequest(request(token), f.store);
  assert.equal(auth.resolveRequestContext(request(token)).authenticated, false);
});

test('legacy sessions retain their existing repository persistence contract', async () => {
  let persisted;
  const auth = new AuthService({ getUser: () => ({ UserID: 'U-1', Status: 'ACTIVE', CompanyID: 'C', BrokerageID: 'B' }),
    getSettings: () => ({}), upsertSession: session => { persisted = session; } });
  const token = await auth.issueDurableSession({ userId: 'U-1' }, null);
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(persisted.sessionId, token);
});

test('deactivating a user removes the durable session before any later reactivation', async () => {
  const f = fixture(); const auth = f.auth();
  const token = await auth.issueDurableSession({ userId: 'U-1' }, f.store);
  f.user.Status = 'INACTIVE';
  await auth.prepareRequest(request(token), f.store);
  assert.equal(f.rows.size, 0);
  f.user.Status = 'ACTIVE';
  await auth.prepareRequest(request(token), f.store);
  assert.equal(auth.resolveRequestContext(request(token)).authenticated, false);
});

test('revocation failure is reported instead of claiming logout succeeded', async () => {
  const f = fixture(); const auth = f.auth();
  const token = await auth.issueDurableSession({ userId: 'U-1' }, f.store);
  f.setFail(true);
  await assert.rejects(auth.revokeDurableSession(token, f.store), { statusCode: 503 });
  assert.equal(f.rows.size, 1);
});
