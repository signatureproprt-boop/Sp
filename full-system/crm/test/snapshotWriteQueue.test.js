'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotWriteQueue } = require('../src/data/snapshotWriteQueue');
const { __threeWayMergeForTests: merge } = require('../src/data/mongoStore');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('a burst of 1000 waiting saves persists one final snapshot without losing clients or remote edits', async () => {
  const base = { Leads: [{ LeadID: 'original', Notes: 'before' }], Requirements: [] };
  let remote = { Leads: [{ LeadID: 'original', Notes: 'remote edit' }, { LeadID: 'remote-client' }], Requirements: [] };
  const batches = [];
  const queue = createSnapshotWriteQueue(async (first, final) => { batches.push({first, final}); remote = merge(first, final, remote); });
  let local = structuredClone(base);
  const pending = [];
  for (let i = 0; i < 1000; i++) {
    const before = structuredClone(local);
    local.Leads.push({ LeadID: `L${i}`, ClientName: `Client ${i}` });
    pending.push(queue.enqueue(before, structuredClone(local)));
  }
  await Promise.all(pending);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].first, base);
  assert.equal(remote.Leads.length, 1002);
  assert.equal(remote.Leads.find(l => l.LeadID === 'original').Notes, 'remote edit');
  assert.equal(new Set(remote.Leads.map(l => l.LeadID)).size, 1002);
});

test('running snapshot remains immutable; waiting callers cannot acknowledge before their batch persists', async () => {
  const gates = [deferred(), deferred()], began = [deferred(), deferred()];
  const writes = [];
  const queue = createSnapshotWriteQueue(async (base, desired) => {
    const i = writes.length;
    writes.push({base, desired}); began[i].resolve(); await gates[i].promise;
  });
  const first = queue.enqueue({ value: 0 }, { value: 1 });
  await began[0].promise;
  let acknowledged = false;
  const second = queue.enqueue({ value: 1 }, { value: 2 });
  const third = queue.enqueue({ value: 2 }, { value: 3 });
  third.then(() => { acknowledged = true; });
  assert.deepEqual(writes[0].desired, { value: 1 });
  gates[0].resolve(); await first; await began[1].promise;
  assert.equal(acknowledged, false);
  assert.deepEqual(writes[1], { base: { value: 1 }, desired: { value: 3 } });
  gates[1].resolve(); await Promise.all([second, third]);
  assert.equal(acknowledged, true); assert.equal(writes.length, 2);
});

test('all callers in a failed batch reject and a subsequent save can recover', async () => {
  let fail = true;
  const queue = createSnapshotWriteQueue(async () => { if (fail) throw new Error('storage failed'); });
  const results = await Promise.allSettled([queue.enqueue({}, { a: 1 }), queue.enqueue({ a: 1 }, { a: 2 })]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.message === 'storage failed'));
  fail = false;
  await queue.enqueue({}, { a: 3 });
});

test('batched changes preserve unrelated work, explicit clears and archived identity evidence', async () => {
  const base = { Leads: [{ LeadID: 'L1', AlternateMobile: '9000000001' }], FollowUps: [{ FollowUpID: 'F1', Notes: 'old' }], SourceSheetArtifacts: [{ ArtifactID: 'A1', OriginalLead: { LeadID: 'conflict' } }] };
  const middle = structuredClone(base); middle.Leads[0].AlternateMobile = null;
  const final = structuredClone(middle); final.Leads.push({ LeadID: 'L2' });
  let remote = structuredClone(base); remote.FollowUps[0].Notes = 'another agent updated';
  const queue = createSnapshotWriteQueue(async (a,b) => { remote = merge(a,b,remote); });
  await Promise.all([queue.enqueue(base, middle), queue.enqueue(middle, final)]);
  assert.equal(remote.Leads[0].AlternateMobile, null);
  assert.equal(remote.FollowUps[0].Notes, 'another agent updated');
  assert.deepEqual(remote.SourceSheetArtifacts, base.SourceSheetArtifacts);
});

test('local counter allocation skips IDs already present in imported records',()=>{
 const {IdEngine}=require('../src/data/idEngine');
 let db={Leads:[{LeadID:'L000002'},{LeadID:'L000003'}],Requirements:[{RequirementID:'R000002'}],Transactions:[],_V2Counters:{Lead:1,Requirement:1,Transaction:0}};
 const engine=new IdEngine({read:()=>structuredClone(db),write:next=>db=next});
 assert.equal(engine.nextLeadId(),'L000004');assert.equal(engine.nextRequirementId(),'R000003');assert.equal(engine.nextTransactionId(),'T000001');
});
