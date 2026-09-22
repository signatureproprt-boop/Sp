'use strict';

/**
 * mongoStore — snapshot-based Mongo backing for JsonRepository.
 *
 * The existing repository interface is fully synchronous (read/write). We
 * preserve that by:
 *   1. Loading the entire DB snapshot from Mongo into an in-memory cache
 *      during an async pre-boot phase (initMongo()).
 *   2. Returning that cache from read() (deep-clone-per-call so mutations
 *      by callers don't sneak through until write() commits).
 *   3. Serializing writes into a background persist queue that upserts a
 *      single snapshot document `{ _id: "singleton" }` in the
 *      `db_snapshot` collection.
 *
 * A single-document snapshot keeps migration trivial (no per-collection
 * schema churn) and easily fits under the 16 MB BSON limit for realistic
 * broker CRM sizes (current DB is ~600 KB).
 *
 * Env:
 *   STORAGE_MODE = "mongo" | "json"                (default: json)
 *   MONGO_URL    = "mongodb://localhost:27017"     (required when mongo)
 *   MONGO_DB     = database name                   (default: signature_properties)
 */

const { MongoClient } = require('mongodb');
const fs = require('fs');

function getStorageMode() {
  return String(process.env.STORAGE_MODE || 'json').trim().toLowerCase();
}

function getMongoUrl() {
  return String(process.env.MONGO_URL || '').trim();
}

function getMongoDb() {
  return String(process.env.MONGO_DB || 'signature_properties').trim();
}

function getPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SNAP_COLL    = 'db_snapshot';
const SNAP_ID      = 'singleton';
const MONGO_SOCKET_TIMEOUT_MS = getPositiveIntegerEnv('MONGO_SOCKET_TIMEOUT_MS', 45000);
const MONGO_CONNECT_TIMEOUT_MS = getPositiveIntegerEnv('MONGO_CONNECT_TIMEOUT_MS', 30000);
const MONGO_SERVER_SELECTION_TIMEOUT_MS = getPositiveIntegerEnv('MONGO_SERVER_SELECTION_TIMEOUT_MS', 30000);
const MONGO_POLL_INTERVAL_MS = getPositiveIntegerEnv('MONGO_POLL_INTERVAL_MS', 10000);
const POLL_QUERY_MAX_TIME_MS = 10000;
const POLL_FAILURES_BEFORE_RECONNECT = 3;

function redactMongoSecrets(value) {
  if (value == null) return value;
  let redacted = String(value);
  const mongoUrl = getMongoUrl();
  if (mongoUrl) {
    redacted = redacted.replace(mongoUrl, sanitizeMongoUrl(mongoUrl));
  }
  return redacted
    .replace(/(mongodb(?:\+srv)?:\/\/)([^:@/]+)(:[^@/]+)?@/gi, '$1[redacted]@');
}

function sanitizeMongoUrl(url) {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url);
    const username = parsed.username ? '[redacted]' : '';
    const password = parsed.password ? '[redacted]' : '';
    const auth = username || password ? `${username}:${password}@` : '';
    return `${parsed.protocol}//${auth}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname || ''}`;
  } catch (error) {
    return url.replace(/(:\/\/)([^:@/]+)(:[^@/]+)?@/i, '$1[redacted]@').replace(/(mongodb\+srv:\/\/)([^:@/]+)(:[^@/]+)?@/i, '$1[redacted]@');
  }
}

function serializeMongoError(error) {
  const reason = error && error.reason;
  const cause = error && error.cause;
  const nestedCause = cause && cause.cause;
  return {
    name: redactMongoSecrets(error && error.name),
    message: redactMongoSecrets(error && error.message),
    code: error && error.code,
    codeName: redactMongoSecrets(error && error.codeName),
    reason: reason ? {
      name: redactMongoSecrets(reason.name),
      message: redactMongoSecrets(reason.message),
      code: reason.code,
      codeName: redactMongoSecrets(reason.codeName),
      type: redactMongoSecrets(reason.type)
    } : undefined,
    cause: cause ? {
      name: redactMongoSecrets(cause.name),
      message: redactMongoSecrets(cause.message),
      code: cause.code,
      codeName: redactMongoSecrets(cause.codeName),
      nestedCause: nestedCause ? {
        name: redactMongoSecrets(nestedCause.name),
        message: redactMongoSecrets(nestedCause.message),
        code: nestedCause.code,
        library: redactMongoSecrets(nestedCause.library),
        reason: redactMongoSecrets(nestedCause.reason)
      } : undefined
    } : undefined,
    stack: redactMongoSecrets(error && error.stack)
  };
}

function writeMongoStderr(line) {
  fs.writeSync(2, `${line}\n`);
}

function logMongoInitializationError(error) {
  const diagnostic = serializeMongoError(error);
  const lines = [
    '[mongo] initialization failed',
    `[mongo] error.name: ${diagnostic.name || '(unknown)'}`,
    `[mongo] error.message: ${diagnostic.message || '(none)'}`,
    `[mongo] error.code: ${diagnostic.code == null ? '(none)' : diagnostic.code}`,
    `[mongo] error.codeName: ${diagnostic.codeName || '(none)'}`,
    `[mongo] error.reason: ${diagnostic.reason ? JSON.stringify(diagnostic.reason) : '(none)'}`,
    `[mongo] error.cause: ${diagnostic.cause ? JSON.stringify(diagnostic.cause) : '(none)'}`,
    `[mongo] error.stack: ${diagnostic.stack || '(none)'}`
  ];
  for (const line of lines) {
    writeMongoStderr(line);
  }
}

let _client = null;
let _db = null;
let _cache = null;
let _initialized = false;
let _initPromise = null;
let _initAttempts = 0;
let _clientCreations = 0;
let _writeQueue = Promise.resolve();
let _lastWriteError = null;
let _writeStats = { successes: 0, failures: 0, conflicts: 0, lastWriteAt: null };
let _lastLocalWriteAt = 0;
let _pollTimer = null;
let _pollFailureCount = 0;
let _reconnectPromise = null;
let _reconnectAttempts = 0;

// Keep the distributed snapshot lock short-lived so a crashed Cloud Run
// instance cannot block all writers for minutes. Writers retry long enough
// to bridge normal multi-instance startup/rollout contention.
const SNAPSHOT_WRITE_LEASE_MS = getPositiveIntegerEnv('MONGO_SNAPSHOT_WRITE_LEASE_MS', 15000);
const SNAPSHOT_WRITE_RETRIES = getPositiveIntegerEnv('MONGO_SNAPSHOT_WRITE_RETRIES', 12);
const SNAPSHOT_WRITE_RETRY_DELAY_MS = getPositiveIntegerEnv('MONGO_SNAPSHOT_WRITE_RETRY_DELAY_MS', 2000);

function isEnabled() {
  return getStorageMode() === 'mongo' && !!getMongoUrl();
}

function isInitialized() {
  return _initialized;
}

function createMongoClient(mongoUrl) {
  _clientCreations += 1;
  const mongoOptions = {
    serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
    connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    retryWrites: true,
    readPreference: 'primary',
    maxPoolSize: 20,
    minPoolSize: 1,
    heartbeatFrequencyMS: 10000
  };
  if (/^mongodb\\+srv:/i.test(mongoUrl) || /[?&](?:tls|ssl)=true(?:&|$)/i.test(mongoUrl)) {
    mongoOptions.tls = true;
    mongoOptions.tlsAllowInvalidCertificates = false;
    mongoOptions.tlsAllowInvalidHostnames = false;
  }
  return new MongoClient(mongoUrl, mongoOptions);
}

function getDb() {
  return _initialized ? _db : null;
}

async function initMongo(fallbackJsonPath) {
  if (!isEnabled()) return { skipped: true, reason: 'STORAGE_MODE!=mongo or missing MONGO_URL' };
  if (_initialized) return { skipped: true, reason: 'already initialized' };
  if (_initPromise) return _initPromise;
  _initPromise = initMongoOnce(fallbackJsonPath).catch((error) => {
    _initPromise = null;
    throw error;
  });
  return _initPromise;
}

async function initMongoOnce(fallbackJsonPath) {
  _initAttempts += 1;
  const mongoUrl = getMongoUrl();
  const mongoDb = getMongoDb();

  console.log('[mongo] initialization starting');
  console.log('[mongo] target URL:', sanitizeMongoUrl(mongoUrl));

  try {
    _client = createMongoClient(mongoUrl);
    try {
      await _client.connect();
    } catch (error) {
      _lastWriteError = error;
      logMongoInitializationError(error);
      throw error;
    }
    console.log('[mongo] connection successful');
    _db = _client.db(mongoDb);
    console.log('[mongo] database selected:', mongoDb);

    const snap = await _db.collection(SNAP_COLL).findOne({ _id: SNAP_ID });
    if (snap && snap.payload) {
      _cache = snap.payload;
      _initialized = true;
      console.log('[mongo] initialization complete');
      startPolling();
      return { ok: true, source: 'mongo', size: JSON.stringify(_cache).length };
    }

    _cache = {};
    _initialized = true;
    console.log('[mongo] initialization complete');
    startPolling();
    return { ok: true, source: 'fresh', size: 0 };
  } catch (error) {
    _lastWriteError = error;
    if (!_client || _db) logMongoInitializationError(error);
    console.error('[mongo] target URL:', sanitizeMongoUrl(mongoUrl));
    throw error;
  }
}

async function reconnectMongo() {
  if (_reconnectPromise) return _reconnectPromise;
  _reconnectAttempts += 1;
  _reconnectPromise = (async () => {
    const previousClient = _client;
    const mongoUrl = getMongoUrl();
    const mongoDb = getMongoDb();
    let replacementClient = null;
    try {
      console.warn('[mongoStore] reconnecting after consecutive poll failures');
      replacementClient = createMongoClient(mongoUrl);
      await replacementClient.connect();
      const replacementDb = replacementClient.db(mongoDb);
      await replacementDb.command({ ping: 1 });
      _client = replacementClient;
      _db = replacementDb;
      _pollFailureCount = 0;
      replacementClient = null;
      console.log('[mongoStore] reconnect successful');
      if (previousClient && previousClient !== _client) {
        await _writeQueue;
        try { await previousClient.close(); } catch (closeError) {
          console.error('[mongoStore] previous client close failed:', closeError.message);
        }
      }
      return true;
    } catch (error) {
      console.error('[mongoStore] reconnect failed:', error.message);
      if (replacementClient) {
        try { await replacementClient.close(); } catch (_) {}
      }
      return false;
    } finally {
      _reconnectPromise = null;
    }
  })();
  return _reconnectPromise;
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(pollOnce, MONGO_POLL_INTERVAL_MS);
}

async function pollOnce() {
  if (!_initialized || !_db) return;
  const activeDb = _db;
  try {
    const snap = await activeDb.collection(SNAP_COLL).findOne(
      { _id: SNAP_ID },
      { projection: { payload: 1, updatedAt: 1 }, maxTimeMS: POLL_QUERY_MAX_TIME_MS }
    );
    _pollFailureCount = 0;
    if (snap && snap.payload && snap.updatedAt) {
      const snapTime = new Date(snap.updatedAt).getTime();
      if (snapTime > _lastLocalWriteAt) _cache = snap.payload;
    }
  } catch (e) {
    _pollFailureCount += 1;
    console.error('[mongoStore] poll refresh failed:', e.message);
    if (_pollFailureCount >= POLL_FAILURES_BEFORE_RECONNECT) await reconnectMongo();
  }
}

function read() {
  if (!_initialized) throw new Error('mongoStore.read() called before initMongo()');
  return JSON.parse(JSON.stringify(_cache));
}

function readCollection(collection) {
  if (!_initialized) throw new Error('mongoStore.readCollection() called before initMongo()');
  const key = String(collection || '').trim();
  if (!key) return [];
  const rows = _cache && Array.isArray(_cache[key]) ? _cache[key] : [];
  return JSON.parse(JSON.stringify(rows));
}

/**
 * Snapshot writes use a distributed Mongo lock plus a three-way merge:
 *   base = this replica's snapshot when the mutation started
 *   desired = this replica's new snapshot
 *   remote = latest committed snapshot in Mongo
 *
 * This preserves concurrent changes made by other Cloud Run instances
 * instead of blindly replacing the entire remote snapshot with a stale copy.
 * Object fields are merged recursively. Arrays containing stable *ID keys
 * are merged by record identity; primitive/unkeyed arrays use last-writer
 * semantics because there is no safe identity to merge on.
 */
function write(db) {
  if (!_initialized) throw new Error('mongoStore.write() called before initMongo()');

  const base = JSON.parse(JSON.stringify(_cache || {}));
  const desired = JSON.parse(JSON.stringify(db || {}));
  _cache = desired;
  _lastLocalWriteAt = Date.now();

  const persist = async () => {
    const activeDb = _db;
    if (!activeDb) throw new Error('Mongo database handle is unavailable');

    let lastError = null;
    for (let attempt = 1; attempt <= SNAPSHOT_WRITE_RETRIES; attempt += 1) {
      try {
        const result = await withDistributedLock('db-snapshot-write', async () => {
          const current = await activeDb.collection(SNAP_COLL).findOne(
            { _id: SNAP_ID },
            { projection: { payload: 1, updatedAt: 1 }, maxTimeMS: POLL_QUERY_MAX_TIME_MS }
          );
          const remote = current && current.payload ? current.payload : {};
          const merged = threeWayMerge(base, desired, remote);

          await activeDb.collection(SNAP_COLL).replaceOne(
            { _id: SNAP_ID },
            {
              _id: SNAP_ID,
              payload: merged,
              updatedAt: new Date(),
              schemaVersion: 2
            },
            { upsert: true }
          );

          _cache = merged;
          return { merged, hadRemoteDivergence: !deepEqual(base, remote) };
        }, { leaseMs: SNAPSHOT_WRITE_LEASE_MS });

        if (result.acquired) {
          _writeStats.successes += 1;
          if (result.result && result.result.hadRemoteDivergence) _writeStats.conflicts += 1;
          _writeStats.lastWriteAt = new Date();
          _lastWriteError = null;
          console.log('[mongoStore] snapshot lock acquired and write succeeded:', JSON.stringify({ attempt }));
          return result.result;
        }

        console.warn('[mongoStore] snapshot lock busy; retrying:', JSON.stringify({
          attempt,
          retries: SNAPSHOT_WRITE_RETRIES,
          retryDelayMs: SNAPSHOT_WRITE_RETRY_DELAY_MS,
          leaseMs: SNAPSHOT_WRITE_LEASE_MS
        }));
        if (attempt < SNAPSHOT_WRITE_RETRIES) await delay(SNAPSHOT_WRITE_RETRY_DELAY_MS);
      } catch (error) {
        lastError = error;
        const diagnostic = serializeMongoError(error);
        console.error('[mongoStore] snapshot write attempt failed:', JSON.stringify({
          attempt,
          retries: SNAPSHOT_WRITE_RETRIES,
          name: diagnostic.name || null,
          message: diagnostic.message || null,
          code: diagnostic.code == null ? null : diagnostic.code,
          codeName: diagnostic.codeName || null,
          reason: diagnostic.reason || null,
          cause: diagnostic.cause || null
        }));
        if (attempt < SNAPSHOT_WRITE_RETRIES) await delay(Math.min(250 * attempt, 1000));
      }
    }

    if (lastError) {
      const diagnostic = serializeMongoError(lastError);
      console.error('[mongoStore] snapshot write exhausted retries:', JSON.stringify({
        retries: SNAPSHOT_WRITE_RETRIES,
        name: diagnostic.name || null,
        message: diagnostic.message || null,
        code: diagnostic.code == null ? null : diagnostic.code,
        codeName: diagnostic.codeName || null,
        reason: diagnostic.reason || null,
        cause: diagnostic.cause || null
      }));
    }
    throw lastError || new Error('Mongo snapshot write failed');
  };

  _writeQueue = _writeQueue.catch(() => {}).then(persist).catch((error) => {
    _writeStats.failures += 1;
    _lastWriteError = error;
    const diagnostic = serializeMongoError(error);
    console.error('[mongoStore] durable snapshot write failed:', JSON.stringify({
      name: diagnostic.name || null,
      message: diagnostic.message || null,
      code: diagnostic.code == null ? null : diagnostic.code,
      codeName: diagnostic.codeName || null,
      reason: diagnostic.reason || null,
      cause: diagnostic.cause || null
    }));
    throw error;
  });

  // Preserve the existing synchronous repository contract while exposing a
  // Promise for future callers that want request-level durability.
  return _writeQueue;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableArrayIdKey(values) {
  if (!Array.isArray(values) || !values.length || !values.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return null;
  const candidates = ['id', 'ID', 'Id'];
  const discovered = Object.keys(values[0] || {}).filter((key) => /id$/i.test(key));
  for (const key of [...candidates, ...discovered]) {
    if (values.every((item) => item[key] != null && item[key] !== '')) {
      return key;
    }
  }
  return null;
}

function mergeArray(base, desired, remote) {
  const key = stableArrayIdKey([...base, ...desired, ...remote]);
  if (!key) {
    if (deepEqual(desired, base)) return clone(remote);
    if (deepEqual(remote, base)) return clone(desired);
    return clone(desired);
  }

  const hasUniqueIds = (rows) => {
    const ids = new Set();
    for (const row of rows || []) {
      const id = String(row[key]);
      if (ids.has(id)) return false;
      ids.add(id);
    }
    return true;
  };
  if (!hasUniqueIds(base) || !hasUniqueIds(desired) || !hasUniqueIds(remote)) {
    return clone(desired);
  }
  const baseMap = new Map((base || []).map((row) => [String(row[key]), row]));
  const desiredMap = new Map((desired || []).map((row) => [String(row[key]), row]));
  const remoteMap = new Map((remote || []).map((row) => [String(row[key]), row]));
  const order = [];
  for (const row of remote || []) if (!order.includes(String(row[key]))) order.push(String(row[key]));
  for (const row of desired || []) if (!order.includes(String(row[key]))) order.push(String(row[key]));

  const out = [];
  for (const id of order) {
    const b = baseMap.get(id);
    const d = desiredMap.get(id);
    const r = remoteMap.get(id);

    if (b !== undefined && d === undefined) {
      if (r !== undefined && !deepEqual(r, b)) out.push(clone(r));
      continue;
    }
    if (b === undefined && d !== undefined) {
      out.push(clone(r === undefined ? d : threeWayMerge({}, d, r)));
      continue;
    }
    if (d === undefined && r === undefined) continue;
    out.push(clone(threeWayMerge(b === undefined ? {} : b, d === undefined ? {} : d, r === undefined ? {} : r)));
  }
  return out;
}

function threeWayMerge(base, desired, remote) {
  if (deepEqual(desired, base)) return clone(remote);
  if (deepEqual(remote, base)) return clone(desired);
  if (Array.isArray(base) && Array.isArray(desired) && Array.isArray(remote)) {
    return mergeArray(base, desired, remote);
  }
  if (base && desired && remote &&
      typeof base === 'object' && typeof desired === 'object' && typeof remote === 'object' &&
      !Array.isArray(base) && !Array.isArray(desired) && !Array.isArray(remote)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(desired), ...Object.keys(remote)]);
    const out = {};
    for (const key of keys) {
      const hasB = Object.prototype.hasOwnProperty.call(base, key);
      const hasD = Object.prototype.hasOwnProperty.call(desired, key);
      const hasR = Object.prototype.hasOwnProperty.call(remote, key);
      if (!hasD && hasB) {
        if (!hasR || deepEqual(remote[key], base[key])) continue;
        out[key] = clone(remote[key]);
        continue;
      }
      if (!hasR && hasD) {
        if (!hasB || !deepEqual(desired[key], base[key])) out[key] = clone(desired[key]);
        continue;
      }
      out[key] = threeWayMerge(hasB ? base[key] : {}, hasD ? desired[key] : {}, hasR ? remote[key] : {});
    }
    return out;
  }
  // Same scalar/shape changed on both sides: desired is the deterministic
  // winner for this exact field; unrelated concurrent fields are preserved
  // by the recursive merge above.
  return clone(desired);
}

async function flush() {
  try {
    await _writeQueue;
  } catch (_) {}
  return { ..._writeStats, lastError: _lastWriteError ? _lastWriteError.message : null };
}

async function withDistributedLock(lockName, fn, options = {}) {
  if (!_initialized || !_db) throw new Error('Mongo store is not initialized');
  const name = String(lockName || '').trim();
  if (!name) throw new Error('lockName is required');
  const leaseMs = Number.isFinite(Number(options.leaseMs)) && Number(options.leaseMs) > 0 ? Number(options.leaseMs) : 15000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const owner = cryptoRandomToken();
  const locks = _db.collection('distributed_locks');
  try {
    const result = await locks.findOneAndUpdate(
      { _id: name, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, expiresAt, updatedAt: now }, $setOnInsert: { _id: name, createdAt: now } },
      { upsert: true, returnDocument: 'after' }
    );
    const lockDoc = result && result.value ? result.value : result;
    if (!lockDoc || lockDoc.owner !== owner) {
      console.warn('[mongoStore] distributed lock not acquired:', JSON.stringify({
        lockName: name,
        owner,
        lockOwner: lockDoc && lockDoc.owner ? lockDoc.owner : null,
        expiresAt: lockDoc && lockDoc.expiresAt ? lockDoc.expiresAt : null
      }));
      return { acquired: false };
    }
    console.log('[mongoStore] distributed lock acquired:', JSON.stringify({ lockName: name, owner, expiresAt }));
    try {
      return { acquired: true, result: await fn() };
    } finally {
      await locks.deleteOne({ _id: name, owner }).catch((error) => {
        console.error('[mongoStore] distributed lock release failed:', JSON.stringify(serializeMongoError(error)));
      });
    }
  } catch (error) {
    if (error && error.code === 11000) {
      console.warn('[mongoStore] distributed lock contention (duplicate key):', JSON.stringify({ lockName: name }));
      return { acquired: false };
    }
    console.error('[mongoStore] distributed lock operation failed:', JSON.stringify(serializeMongoError(error)));
    throw error;
  }
}

function cryptoRandomToken() {
  return require('node:crypto').randomBytes(16).toString('hex');
}


function close() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_client) {
    return _client.close();
  }
  return Promise.resolve();
}

function stats() {
  return {
    enabled: isEnabled(),
    initialized: _initialized,
    initializationInProgress: !!_initPromise && !_initialized,
    initAttempts: _initAttempts,
    clientCreations: _clientCreations,
    pollFailureCount: _pollFailureCount,
    reconnectInProgress: !!_reconnectPromise,
    reconnectAttempts: _reconnectAttempts,
    cacheSize: _cache ? JSON.stringify(_cache).length : 0,
    ..._writeStats,
    lastError: _lastWriteError ? _lastWriteError.message : null
  };
}

module.exports = {
  isEnabled,
  isInitialized,
  getDb,
  initMongo,
  read,
  readCollection,
  write,
  flush,
  close,
  stats,
  withDistributedLock,
  MONGO_SOCKET_TIMEOUT_MS,
  MONGO_CONNECT_TIMEOUT_MS,
  MONGO_SERVER_SELECTION_TIMEOUT_MS,
  MONGO_POLL_INTERVAL_MS,
  __pollOnceForTests: pollOnce,
  __threeWayMergeForTests: threeWayMerge,
  __mergeArrayForTests: mergeArray
};
