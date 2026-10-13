'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mongoModulePath = require.resolve('mongodb');
const storeModulePath = require.resolve('../src/data/mongoStore');
const originalMongoModule = require.cache[mongoModulePath];
const originalEnv = { ...process.env };

test('unchanged snapshots do not transfer payload again; changed snapshots refresh once', async () => {
  let snapshot = { payload: { Leads: [{ LeadID: 'first' }] }, updatedAt: new Date(1000) };
  let payloadTransfers = 0;
  class Client {
    async connect() {}
    async close() {}
    db() {
      return { collection: () => ({ findOne: async (filter) => {
        if (filter.updatedAt && snapshot.updatedAt <= filter.updatedAt.$gt) return null;
        payloadTransfers += 1;
        return snapshot;
      } }) };
    }
  }
  const store = loadStore({ MongoClient: Client });
  try {
    await store.initMongo();
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    assert.equal(payloadTransfers, 1);
    snapshot = { payload: { Leads: [{ LeadID: 'changed' }] }, updatedAt: new Date(2000) };
    await store.__pollOnceForTests();
    assert.equal(store.read().Leads[0].LeadID, 'changed');
    await store.__pollOnceForTests();
    assert.equal(payloadTransfers, 2);
  } finally { await cleanupStore(store); }
});

function makeFakeMongo() {
  const clients = [];
  let pollFailuresRemaining = 0;
  let reconnectConnectPromise = null;
  let reconnectConnectResolve = null;
  let reconnectConnectReject = null;

  class FakeMongoClient {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.closed = false;
      this.isReplacement = clients.length > 0;
      clients.push(this);
    }

    async connect() {
      if (this.isReplacement && reconnectConnectPromise) return reconnectConnectPromise;
    }

    db() {
      return {
        command: async () => {},
        collection: () => ({
          findOne: async () => {
            if (pollFailuresRemaining > 0) {
              pollFailuresRemaining -= 1;
              throw new Error('poll outage');
            }
            return { payload: { Leads: [{ LeadID: this.isReplacement ? 'reconnected' : 'initial' }] }, updatedAt: new Date(Date.now() + 1000) };
          },
          replaceOne: async () => {}
        })
      };
    }

    async close() {
      this.closed = true;
    }
  }

  return {
    MongoClient: FakeMongoClient,
    clients,
    setPollFailures(count) { pollFailuresRemaining = count; },
    holdReconnect(shouldReject = false) {
      reconnectConnectPromise = new Promise((resolve, reject) => {
        reconnectConnectResolve = resolve;
        reconnectConnectReject = reject;
      });
      if (shouldReject) reconnectConnectReject(new Error('reconnect outage'));
    },
    releaseReconnect() {
      reconnectConnectResolve();
      reconnectConnectPromise = null;
    }
  };
}

function loadStore(fakeMongo, env = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, {
    STORAGE_MODE: 'mongo',
    MONGO_URL: 'mongodb://fake.test:27017/signature_properties',
    MONGO_DB: 'signature_properties',
    ...env
  });
  delete require.cache[storeModulePath];
  require.cache[mongoModulePath] = { exports: fakeMongo };
  return require('../src/data/mongoStore');
}

async function cleanupStore(store) {
  await store.close();
  delete require.cache[storeModulePath];
  if (originalMongoModule) require.cache[mongoModulePath] = originalMongoModule;
  else delete require.cache[mongoModulePath];
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

test('Mongo resilience defaults and polling preserve cache during an outage', async () => {
  const fakeMongo = makeFakeMongo();
  const store = loadStore(fakeMongo);
  try {
    assert.equal(store.MONGO_SOCKET_TIMEOUT_MS, 45000);
    assert.equal(store.MONGO_CONNECT_TIMEOUT_MS, 30000);
    assert.equal(store.MONGO_SERVER_SELECTION_TIMEOUT_MS, 30000);
    assert.equal(store.MONGO_POLL_INTERVAL_MS, 10000);

    await store.initMongo();
    const initialCache = store.read();
    fakeMongo.setPollFailures(2);
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    assert.deepEqual(store.read(), initialCache);
    assert.equal(store.stats().pollFailureCount, 2);
  } finally {
    await cleanupStore(store);
  }
});

test('reconnects once after three failures, swaps handles, and resets failures', async () => {
  const fakeMongo = makeFakeMongo();
  const store = loadStore(fakeMongo);
  try {
    await store.initMongo();
    fakeMongo.setPollFailures(3);
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();

    assert.equal(fakeMongo.clients.length, 2);
    assert.equal(fakeMongo.clients[0].closed, true);
    assert.equal(store.stats().pollFailureCount, 0);
    assert.equal(store.stats().reconnectAttempts, 1);
    assert.equal(store.read().Leads[0].LeadID, 'reconnected');
  } finally {
    await cleanupStore(store);
  }
});

test('reconnect in progress is single-flight and preserves the old cache', async () => {
  const fakeMongo = makeFakeMongo();
  const store = loadStore(fakeMongo);
  try {
    await store.initMongo();
    const initialCache = store.read();
    fakeMongo.setPollFailures(3);
    fakeMongo.holdReconnect();

    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    const third = store.__pollOnceForTests();
    await Promise.resolve();
    const fourth = store.__pollOnceForTests();
    assert.equal(fakeMongo.clients.length, 2);
    assert.equal(store.stats().reconnectInProgress, true);
    fakeMongo.releaseReconnect();
    await Promise.all([third, fourth]);
    assert.deepEqual(store.read(), initialCache);
    assert.equal(store.stats().reconnectAttempts, 1);
  } finally {
    await cleanupStore(store);
  }
});

test('reconnect failure keeps the old cache and records the attempt', async () => {
  const fakeMongo = makeFakeMongo();
  const store = loadStore(fakeMongo);
  try {
    await store.initMongo();
    const initialCache = store.read();
    fakeMongo.setPollFailures(3);
    fakeMongo.holdReconnect(true);
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    await store.__pollOnceForTests();
    assert.deepEqual(store.read(), initialCache);
    assert.equal(store.stats().reconnectAttempts, 1);
    assert.equal(store.stats().pollFailureCount, 3);
  } finally {
    await cleanupStore(store);
  }
});

test('older snapshot completion and polling cannot erase newer queued local changes', async () => {
  let snapshot={payload:{Leads:[]},updatedAt:new Date(1)};
  const gates=[];
  const started=[];
  const resolvers=[];
  for(let i=0;i<2;i++) started[i]=new Promise(resolve=>resolvers[i]=resolve);
  let writes=0;
  class Client {
    async connect(){} async close(){}
    db(){return {collection:name=>name==='distributed_locks'?{
      findOneAndUpdate:async (_filter,update)=>update.$set,
      deleteOne:async()=>{}
    }:{findOne:async()=>snapshot,replaceOne:async (_filter,next)=>{
      const i=writes++;
      const gate=new Promise(resolve=>gates[i]=resolve);
      resolvers[i](); await gate; snapshot=next;
    }}};}
  }
  const store=loadStore({MongoClient:Client});
  try {
    await store.initMongo();
    const first=store.write({Leads:[{LeadID:'new-client',Notes:'initial'}]});
    await started[0];
    const second=store.write({Leads:[{LeadID:'new-client',Notes:'updated'},{LeadID:'second-client'}]});
    await store.__pollOnceForTests();
    assert.equal(store.read().Leads.length,2);
    gates[0](); await first; await started[1];
    assert.equal(store.read().Leads.length,2);
    assert.equal(store.read().Leads[0].Notes,'updated');
    assert.equal(store.stats().pendingWrites,1);
    gates[1](); await second;
    assert.equal(snapshot.payload.Leads.length,2);
    assert.equal(store.stats().pendingWrites,0);
  } finally { for(const gate of gates)gate?.(); await cleanupStore(store); }
});

test('Mongo coalesces queued client saves while preserving a concurrent remote client and durability counts',async()=>{
 let snapshot={payload:{Leads:[],SourceSheetArtifacts:[{ArtifactID:'review',OriginalLead:{LeadID:'original-conflict'}}]},updatedAt:new Date(1)};
 let writes=0,releaseFirst,signalStart;
 const started=new Promise(resolve=>signalStart=resolve);
 class Client {
  async connect(){} async close(){}
  db(){return {collection:name=>name==='distributed_locks'?{
   findOneAndUpdate:async(_filter,update)=>update.$set,
   deleteOne:async()=>{if(writes===1&&!snapshot.payload.Leads.some(l=>l.LeadID==='remote-client'))snapshot.payload.Leads.push({LeadID:'remote-client',Notes:'other replica'});}
  }:{findOne:async()=>snapshot,replaceOne:async(_filter,next)=>{
   writes++;if(writes===1){signalStart();await new Promise(resolve=>releaseFirst=resolve);}snapshot=structuredClone(next);
  }}};}
 }
 const store=loadStore({MongoClient:Client});
 try {
  await store.initMongo();
  let local=structuredClone(snapshot.payload);
  local.Leads.push({LeadID:'first',Notes:'original'});
  const pending=[store.write(local)];await started;
  for(let i=0;i<30;i++){
   local=structuredClone(store.read());local.Leads.push({LeadID:'local-'+i,ClientStatus:'New'});local.Leads[0].Notes='updated-'+i;
   pending.push(store.write(local));
  }
  assert.equal(store.stats().pendingWrites,31);assert.equal(store.read().Leads.length,31);
  releaseFirst();await Promise.all(pending);await store.flush();
  assert.equal(writes,2);assert.equal(store.stats().pendingWrites,0);
  assert.equal(snapshot.payload.Leads.length,32);
  assert.equal(snapshot.payload.Leads[0].Notes,'updated-29');
  assert.equal(snapshot.payload.Leads.find(l=>l.LeadID==='remote-client').Notes,'other replica');
  assert.equal(store.read().Leads.length,32);
  assert.equal(snapshot.payload.SourceSheetArtifacts[0].OriginalLead.LeadID,'original-conflict');
 }finally{releaseFirst?.();await cleanupStore(store);}
});

test('rejected concurrent client creation restores the acknowledged snapshot rather than leaving a phantom client',async()=>{
 let snapshot={payload:{Leads:[]},updatedAt:new Date(1)},writes=0;
 class Client {
  async connect(){} async close(){}
  db(){return {collection:name=>name==='distributed_locks'?{findOneAndUpdate:async(_filter,update)=>update.$set,deleteOne:async()=>{}}:{findOne:async()=>structuredClone(snapshot),replaceOne:async()=>{writes++;}}};}
 }
 const store=loadStore({MongoClient:Client});
 try{
  await store.initMongo();
  snapshot={payload:{Leads:[{LeadID:'L000001',ClientName:'Other replica',PrimaryMobile:'9876543210'}]},updatedAt:new Date(1)};
  await assert.rejects(store.write({Leads:[{LeadID:'L000001',ClientName:'Unsaved client',PrimaryMobile:'9876543211'}]}),error=>error.code==='CONCURRENT_CREATE_CONFLICT');
  await store.__pollOnceForTests();
  assert.equal(writes,0);assert.equal(store.stats().pendingWrites,0);
  assert.equal(store.read().Leads[0].ClientName,'Other replica');
  assert.equal((await store.flush()).lastErrorCode,'CONCURRENT_CREATE_CONFLICT');
 }finally{await cleanupStore(store);}
});
