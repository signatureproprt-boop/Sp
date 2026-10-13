const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AuthService,
  SESSION_COOKIE_NAME
} = require('../src/services/authService');

function makeRepo(user) {
  return {
    getUser: (id) => id === user.UserID ? user : null,
    upsertSession: () => {},
    deleteSession: () => true,
    getSession: () => null,
    getRole: () => null,
    getSettings: () => ({ Security: { SessionTimeoutMinutes: 60 } }),
    normalizeStoredIdentifier: (value) => String(value || '').trim()
  };
}

test('session uses current user role and permissions after an authorization downgrade', () => {
  const user = {
    UserID: 'USR-1',
    Status: 'ACTIVE',
    Role: 'ADMIN',
    CompanyID: 'COMP-1',
    BrokerageID: 'BRK-1',
    Permissions: ['ADMIN_READ', 'LEADS_READ']
  };
  const repo = makeRepo(user);
  const auth = new AuthService(repo);
  const token = auth.issueSession({
    userId: user.UserID,
    role: 'ADMIN',
    companyId: user.CompanyID,
    brokerageId: user.BrokerageID,
    permissions: ['*']
  });

  user.Role = 'AGENT';
  user.Permissions = ['LEADS_READ'];

  const context = auth.resolveRequestContext({
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    pathname: '/api/admin/users'
  });

  assert.equal(context.authenticated, true);
  assert.equal(context.role, 'AGENT');
  assert.deepEqual(context.permissions, ['LEADS_READ']);

  const adminCheck = auth.requirePermission(context, 'ADMIN_READ');
  assert.equal(adminCheck.ok, false);
  assert.equal(adminCheck.statusCode, 403);
});

test('session follows current tenant after a tenant reassignment', () => {
  const user = {
    UserID: 'USR-2',
    Status: 'ACTIVE',
    Role: 'AGENT',
    CompanyID: 'COMP-1',
    BrokerageID: 'BRK-1',
    Permissions: ['LEADS_READ']
  };
  const repo = makeRepo(user);
  const auth = new AuthService(repo);
  const token = auth.issueSession({
    userId: user.UserID,
    role: user.Role,
    companyId: user.CompanyID,
    brokerageId: user.BrokerageID,
    permissions: user.Permissions
  });

  user.CompanyID = 'COMP-2';
  user.BrokerageID = 'BRK-2';

  const context = auth.resolveRequestContext({
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    pathname: '/api/v2/clients'
  });

  assert.equal(context.companyId, 'COMP-2');
  assert.equal(context.brokerageId, 'BRK-2');
});

test('revoked session is rejected even when the old token is presented', () => {
  const user = {
    UserID: 'USR-3',
    Status: 'ACTIVE',
    Role: 'AGENT',
    CompanyID: 'COMP-1',
    BrokerageID: 'BRK-1',
    Permissions: ['LEADS_READ']
  };
  const repo = makeRepo(user);
  const auth = new AuthService(repo);
  const token = auth.issueSession({ userId: user.UserID });

  assert.equal(auth.revokeSession(token), true);

  const context = auth.resolveRequestContext({
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    pathname: '/api/v2/clients'
  });

  assert.equal(context.authenticated, false);
  assert.equal(context.statusCode, 401);
});

test('cross-tenant permission request is denied', () => {
  const user = {
    UserID: 'USR-4',
    Status: 'ACTIVE',
    Role: 'AGENT',
    CompanyID: 'COMP-1',
    BrokerageID: 'BRK-1',
    Permissions: ['LEADS_READ']
  };
  const auth = new AuthService(makeRepo(user));
  const actor = {
    userId: user.UserID,
    role: 'AGENT',
    companyId: 'COMP-1',
    brokerageId: 'BRK-1',
    permissions: ['LEADS_READ'],
    user
  };

  const result = auth.requirePermission(actor, 'LEADS_READ', {
    companyId: 'COMP-2',
    brokerageId: 'BRK-2'
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'Cross-tenant access denied');
});
