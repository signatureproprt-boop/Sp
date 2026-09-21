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
