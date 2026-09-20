'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mongoModulePath = require.resolve('mongodb');
const storeModulePath = require.resolve('../src/data/mongoStore');
const originalMongoModule = require.cache[mongoModulePath];
const originalEnv = { ...process.env };

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