'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { V2Router } = require('../src/api/v2Router');

function routerForFilters() {
  return Object.create(V2Router.prototype);
}

test('client location filter requires a real match when requirement has locations', () => {
  const router = routerForFilters();

  assert.equal(router._reqMatchesFilters({
    Location1: 'Vesu',
    Location2: 'Adajan'
  }, { location: 'vesu' }, []), true);

  assert.equal(router._reqMatchesFilters({
    Location1: 'Vesu',
    Location2: 'Adajan'
  }, { location: 'City Light' }, []), false);

  assert.equal(router._reqMatchesFilters({
    Location1: '',
    Location2: ''
  }, { location: 'Vesu' }, []), false);
});

test('client location filter is case-insensitive and matches either location slot', () => {
  const router = routerForFilters();

  assert.equal(router._reqMatchesFilters({
    Location1: 'vesu',
    Location2: 'PAL'
  }, { location: 'PAL' }, []), true);

  assert.equal(router._reqMatchesFilters({
    Location1: 'vesu',
    Location2: 'PAL'
  }, { location: 'city' }, []), false);
});

test('client workspace rejects duplicate LeadIDs instead of opening the wrong client', async () => {
  const router = routerForFilters();
  router.repo = {
    list: (collection) => collection === 'Leads' ? [
      { LeadID: 'COMM-0057', ClientName: 'Kenil Shah' },
      { LeadID: 'COMM-0057', ClientName: 'Dr Arohi' }
    ] : []
  };
  router.actorResolver = () => ({ userId: 'USR-TEST-ADMIN', role: 'ADMIN' });

  const response = await router.handle(
    { method: 'GET', headers: {} },
    null,
    new URL('https://crm.test/api/clients/COMM-0057/workspace'),
    null
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'AMBIGUOUS_CLIENT_ID');
  assert.match(response.body.error, /multiple client records/i);
});
