'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __threeWayMergeForTests: threeWayMerge
} = require('../src/data/mongoStore');

test('three-way merge preserves concurrent changes to different scalar fields', () => {
  const base = { Settings: { Currency: 'INR', Timezone: 'Asia/Kolkata' } };
  const desired = { Settings: { Currency: 'USD', Timezone: 'Asia/Kolkata' } };
  const remote = { Settings: { Currency: 'INR', Timezone: 'Asia/Dubai' } };

  assert.deepEqual(threeWayMerge(base, desired, remote), {
    Settings: { Currency: 'USD', Timezone: 'Asia/Dubai' }
  });
});

test('three-way merge preserves concurrent CRM rows in keyed arrays', () => {
  const base = {
    Leads: [
      { LeadID: 'L1', Status: 'NEW', Notes: 'A' },
      { LeadID: 'L2', Status: 'NEW', Notes: 'B' }
    ]
  };
  const desired = {
    Leads: [
      { LeadID: 'L1', Status: 'ACTIVE', Notes: 'A' },
      { LeadID: 'L2', Status: 'NEW', Notes: 'B' }
    ]
  };
  const remote = {
    Leads: [
      { LeadID: 'L1', Status: 'NEW', Notes: 'A' },
      { LeadID: 'L2', Status: 'VERIFIED', Notes: 'B' }
    ]
  };

  assert.deepEqual(threeWayMerge(base, desired, remote), {
    Leads: [
      { LeadID: 'L1', Status: 'ACTIVE', Notes: 'A' },
      { LeadID: 'L2', Status: 'VERIFIED', Notes: 'B' }
    ]
  });
});

test('three-way merge keeps a remote edit when another replica deletes a stale row', () => {
  const base = {
    Leads: [
      { LeadID: 'L1', Status: 'NEW', Notes: 'A' }
    ]
  };
  const desired = { Leads: [] };
  const remote = {
    Leads: [
      { LeadID: 'L1', Status: 'ACTIVE', Notes: 'remote edit' }
    ]
  };

  assert.deepEqual(threeWayMerge(base, desired, remote), remote);
});

test('three-way merge applies a local deletion when the remote row is unchanged', () => {
  const base = {
    Leads: [
      { LeadID: 'L1', Status: 'NEW' },
      { LeadID: 'L2', Status: 'NEW' }
    ]
  };
  const desired = {
    Leads: [
      { LeadID: 'L2', Status: 'NEW' }
    ]
  };
  const remote = base;

  assert.deepEqual(threeWayMerge(base, desired, remote), desired);
});

test('three-way merge preserves independent additions from both replicas', () => {
  const base = { Leads: [] };
  const desired = { Leads: [{ LeadID: 'LOCAL', Status: 'NEW' }] };
  const remote = { Leads: [{ LeadID: 'REMOTE', Status: 'NEW' }] };

  assert.deepEqual(threeWayMerge(base, desired, remote), {
    Leads: [
      { LeadID: 'REMOTE', Status: 'NEW' },
      { LeadID: 'LOCAL', Status: 'NEW' }
    ]
  });
});
