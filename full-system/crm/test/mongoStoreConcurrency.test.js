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

test('different records concurrently created with the same ID are rejected instead of merged',()=>{
 const base={Leads:[]},desired={Leads:[{LeadID:'L1',ClientName:'One',PrimaryMobile:'9876543210'}]},remote={Leads:[{LeadID:'L1',ClientName:'Two',PrimaryMobile:'9876543211'}]};
 assert.throws(()=>threeWayMerge(base,desired,remote),error=>error.code==='CONCURRENT_CREATE_CONFLICT');
 assert.deepEqual(threeWayMerge(base,desired,structuredClone(desired)),desired);
});

test('a new cross-replica mobile collision is rejected while existing legacy conflicts can be reviewed',()=>{
 const check=require('../src/data/mongoStore').__assertNoNewPrimaryPhoneConflictForTests;
 const before=[{LeadID:'L1',PrimaryMobile:'9876543210'}];
 assert.throws(()=>check(before,[...before,{LeadID:'L2',PrimaryMobile:'+91 98765-43210'}]),error=>error.code==='DUPLICATE_CLIENT_IDENTITY');
 const legacy=[...before,{LeadID:'L2',PrimaryMobile:'9876543210'}];
 assert.doesNotThrow(()=>check(legacy,legacy.map(l=>({...l,Notes:'same records reviewed'}))));
 assert.doesNotThrow(()=>check(before,[...before,{LeadID:'L3',PrimaryMobile:'9999999999'}]));
});

test('a repeated client foreign key does not hide the actual transaction identity during concurrent edits',()=>{
 const base={Transactions:[{LeadID:'L1',TransactionID:'T1',Notes:'one'},{LeadID:'L1',TransactionID:'T2',Notes:'two'}]};
 const desired=structuredClone(base),remote=structuredClone(base);
 desired.Transactions[0].Notes='local';remote.Transactions[1].Notes='remote';
 const result=threeWayMerge(base,desired,remote);
 assert.deepEqual(result.Transactions.map(t=>t.Notes),['local','remote']);
});
