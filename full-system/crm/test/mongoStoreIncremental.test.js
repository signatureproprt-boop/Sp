'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');

test('incremental snapshots preserve durability and concurrency on real Mongo', { skip: !process.env.MONGO_TEST_URL }, async t => {
  const url = new URL(process.env.MONGO_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Integration tests must use a local disposable Mongo');
  const previousEnv = { STORAGE_MODE: process.env.STORAGE_MODE, MONGO_URL: process.env.MONGO_URL, MONGO_DB: process.env.MONGO_DB };
  const name = `crm_incremental_test_${require('node:crypto').randomBytes(8).toString('hex')}`;
  const client = new MongoClient(url.toString());
  await client.connect();
  const db = client.db(name), snapshots = db.collection('db_snapshot');
  const fixture = {
    Leads: Array.from({ length: 257 }, (_, i) => ({ LeadID: `L${i}`, PrimaryMobile: String(9000000000 + i), Notes: 'before', Location: 'Vesu', ImportedDetails: 'x'.repeat(8000) })),
    Requirements: [{ RequirementID: 'R1', LeadID: 'L0', RequirementStatus: 'Active', BudgetMin: 1000, BudgetMax: 2000 }],
    Activities: [], _V2Counters: { Requirement: 1 },
    BuilderProjects: [{ ProjectID: 'builder', Media: 'b'.repeat(2700000) }],
    SourceSheetArtifacts: [{ ArtifactID: 'source-error', ArchivedAt: 'original', OriginalLead: { LeadID: 'shared' } }]
  };
  await snapshots.insertOne({ _id: 'singleton', payload: fixture, updatedAt: new Date(1) });
  Object.assign(process.env, { STORAGE_MODE: 'mongo', MONGO_URL: url.toString(), MONGO_DB: name });
  const modulePath = require.resolve('../src/data/mongoStore');
  delete require.cache[modulePath];
  const store = require('../src/data/mongoStore');
  try {
    await store.initMongo();
    const activeDb = store.getDb(), collection = activeDb.collection.bind(activeDb);
    let beforeCommit = null;
    const transfers = [], writes = [];
    activeDb.collection = function (name, ...args) {
      const real = collection(name, ...args);
      if (name !== 'db_snapshot') return real;
      return new Proxy(real, { get(target, key) {
        if (key === 'findOne') return async (...args) => {
          const result = await target.findOne(...args);
          transfers.push({ projection: args[1]?.projection, bytes: Buffer.byteLength(JSON.stringify(result)) });
          return result;
        };
        if (key === 'updateOne') return async (...args) => {
          writes.push(args);
          if (beforeCommit) { const action = beforeCommit; beforeCommit = null; await action(); }
          return target.updateOne(...args);
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      } });
    };

    await t.test('a 4.8 MB snapshot sends only the edited client and retains all other data', async () => {
      const desired = store.read(); desired.Leads[0].Notes = '$literal user note';
      await store.write(desired);
      const saved = await snapshots.findOne({ _id: 'singleton' });
      assert.equal(saved.payload.Leads.length, 257);
      assert.equal(saved.payload.Leads[0].Notes, '$literal user note');
      assert.deepEqual(saved.payload.BuilderProjects, fixture.BuilderProjects);
      assert.deepEqual(saved.payload.SourceSheetArtifacts, fixture.SourceSheetArtifacts);
      assert.ok(transfers[0].bytes < 60000, `Changed-record read was ${transfers[0].bytes} bytes`);
      assert.ok(Buffer.byteLength(JSON.stringify(writes[0])) < 20000);
      assert.equal(transfers[0].projection.payload, undefined);
      t.diagnostic(`Snapshot ${Buffer.byteLength(JSON.stringify(fixture))} bytes; changed-record read ${transfers[0].bytes} bytes; write ${Buffer.byteLength(JSON.stringify(writes[0]))} bytes`);
    });

    await t.test('expired-lock racing write retries and preserves remote edits and additions', async () => {
      const desired = store.read(); desired.Leads[0].Notes = 'local notes';
      const count = writes.length;
      beforeCommit = async () => {
        const remote = await snapshots.findOne({ _id: 'singleton' });
        remote.payload.Leads[0].Location = 'Adajan';
        remote.payload.Leads.push({ LeadID: 'remote-added', PrimaryMobile: '8999999999', Notes: 'other agent' });
        await snapshots.updateOne({ _id: 'singleton' }, { $set: { 'payload.Leads': remote.payload.Leads, revision: 'other-writer' } });
      };
      await store.write(desired);
      const saved = await snapshots.findOne({ _id: 'singleton' });
      assert.ok(writes.length >= count + 2, 'Stale compare-and-set must retry');
      assert.equal(saved.payload.Leads[0].Notes, 'local notes');
      assert.equal(saved.payload.Leads[0].Location, 'Adajan');
      assert.equal(saved.payload.Leads.length, 258);
      await store.__pollOnceForTests();
      assert.equal(store.read().Leads.length, 258);
    });

    await t.test('Lost Reopen Close update one requirement without creating clients or requirements', async () => {
      for (const status of ['Lost', 'Active', 'Closed']) {
        const desired = store.read(); desired.Requirements[0].RequirementStatus = status;
        desired.Activities.push({ ActivityID: `A-${status}`, LeadID: 'L0', Notes: status });
        await store.write(desired);
        const saved = await snapshots.findOne({ _id: 'singleton' });
        assert.equal(saved.payload.Requirements.length, 1);
        assert.equal(saved.payload.Requirements[0].RequirementID, 'R1');
        assert.equal(saved.payload.Requirements[0].RequirementStatus, status);
        assert.equal(saved.payload.Leads.length, 258);
      }
      const saved = await snapshots.findOne({ _id: 'singleton' });
      assert.equal(saved.payload.Activities.length, 3);
      assert.deepEqual(saved.payload.SourceSheetArtifacts, fixture.SourceSheetArtifacts);
    });

    await t.test('explicit clears and deletion preserve a concurrently edited remote record', async () => {
      const desired = store.read(); desired.Leads[0].Notes = null;
      desired.Leads = desired.Leads.filter(row => row.LeadID !== 'L1');
      beforeCommit = () => snapshots.updateOne({ _id: 'singleton' }, { $set: { 'payload.Leads.1.Notes': 'remote changed', revision: 'keep-edited-row' } });
      await store.write(desired);
      const saved = await snapshots.findOne({ _id: 'singleton' });
      assert.equal(saved.payload.Leads[0].Notes, null);
      assert.equal(saved.payload.Leads.find(row => row.LeadID === 'L1').Notes, 'remote changed');
      const next = store.read(); next.Leads = next.Leads.filter(row => row.LeadID !== 'L2');
      await store.write(next);
      assert.ok(!(await snapshots.findOne({ _id: 'singleton' })).payload.Leads.some(row => row.LeadID === 'L2'));
    });

    await t.test('background project and queue commit rejects an unpolled remote manual edit atomically', async () => {
      const initial = store.read();
      initial.UploadedBrochureBatches = [{JobID:'background-test',ActorID:'worker:integration',Items:[{ItemID:'pdf',ProjectID:'builder',Status:'reading'}]}];
      await store.write(initial);
      const desired = store.read();
      desired.BuilderProjects[0].BuilderName = 'AI proposal';
      desired.UploadedBrochureBatches[0].Items[0].Status = 'saved';
      beforeCommit = () => snapshots.updateOne({_id:'singleton'}, {$set:{'payload.BuilderProjects.0.BuilderName':'Manual developer',revision:'manual-project-edit'}});
      await assert.rejects(store.write(desired), error => error.code === 'BACKGROUND_PROJECT_CHANGED');
      const saved = await snapshots.findOne({_id:'singleton'});
      assert.equal(saved.payload.BuilderProjects[0].BuilderName,'Manual developer');
      assert.equal(saved.payload.UploadedBrochureBatches[0].Items[0].Status,'reading');
      await store.__pollOnceForTests();
      const retry = store.read();
      retry.BuilderProjects[0].Overview = 'Source checked';
      retry.UploadedBrochureBatches[0].Items[0].Status = 'saved';
      await store.write(retry);
      const resumed = await snapshots.findOne({_id:'singleton'});
      assert.equal(resumed.payload.BuilderProjects[0].BuilderName,'Manual developer');
      assert.equal(resumed.payload.UploadedBrochureBatches[0].Items[0].Status,'saved');
    });

    await t.test('new phone collision rejects before acknowledgement and restores durable cache', async () => {
      const desired = store.read(); desired.Leads.push({ LeadID: 'collision', PrimaryMobile: desired.Leads[0].PrimaryMobile });
      await assert.rejects(store.write(desired), error => error.code === 'DUPLICATE_CLIENT_IDENTITY');
      await store.__pollOnceForTests();
      assert.ok(!store.read().Leads.some(row => row.LeadID === 'collision'));
      assert.ok(!(await snapshots.findOne({ _id: 'singleton' })).payload.Leads.some(row => row.LeadID === 'collision'));
    });
  } finally {
    await store.close(); await db.dropDatabase(); await client.close(); delete require.cache[modulePath];
    for (const [key, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
