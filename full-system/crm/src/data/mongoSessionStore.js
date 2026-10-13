'use strict';

const crypto = require('node:crypto');
const mongoStore = require('./mongoStore');
const TIMEOUT_MS = 10000;

// Small independent records keep login off the full CRM snapshot write queue.
// Resolve the DB lazily so reconnects use the new Mongo handle.
class MongoSessionStore {
  constructor(getDb = () => mongoStore.getDb()) {
    this.getDb = getDb;
    this.indexDb = null;
    this.indexReady = null;
  }

  collection() {
    const db = this.getDb();
    if (!db) throw this.unavailable();
    return db.collection('auth_sessions');
  }

  unavailable() {
    const error = new Error('Session storage is temporarily unavailable. Please try again.');
    error.statusCode = 503;
    return error;
  }

  key(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async ensureIndex() {
    const db = this.getDb();
    if (this.indexDb !== db || !this.indexReady) {
      this.indexDb = db;
      this.indexReady = this.collection().createIndex({ expiresAt: 1 }, {
        expireAfterSeconds: 0, name: 'auth_session_expiry', timeoutMS: TIMEOUT_MS
      }).catch(error => { this.indexReady = null; throw error; });
    }
    await this.indexReady;
  }

  async save(session) {
    try {
      await this.ensureIndex();
      const { sessionId, ...data } = session;
      const expiresAt = new Date(data.expiresAt);
      if (!sessionId || !Number.isFinite(expiresAt.getTime())) throw new Error('Invalid session');
      const result = await this.collection().replaceOne({ _id: this.key(sessionId) },
        { _id: this.key(sessionId), data, expiresAt },
        { upsert: true, writeConcern: { w: 'majority' }, timeoutMS: TIMEOUT_MS });
      if (!result.acknowledged) throw new Error('Session save was not acknowledged');
    } catch (_) { throw this.unavailable(); }
  }

  async load(token) {
    try {
      const row = await this.collection().findOne({ _id: this.key(token) }, { timeoutMS: TIMEOUT_MS });
      const expiry = row && new Date(row.expiresAt).getTime();
      if (!row || !row.data || !Number.isFinite(expiry) || expiry <= Date.now()) return null;
      return { ...row.data, sessionId: token };
    } catch (_) { throw this.unavailable(); }
  }

  async remove(token) {
    try {
      const result = await this.collection().deleteOne({ _id: this.key(token) },
        { writeConcern: { w: 'majority' }, timeoutMS: TIMEOUT_MS });
      if (!result.acknowledged) throw new Error('Session revocation was not acknowledged');
    } catch (_) { throw this.unavailable(); }
  }
}

module.exports = { MongoSessionStore };
