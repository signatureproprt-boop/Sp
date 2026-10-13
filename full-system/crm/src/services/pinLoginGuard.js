'use strict';

const crypto = require('node:crypto');

const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
const AUTH_SECURITY_COLLECTION = 'auth_security';

function cloneState(state = {}) {
  return {
    failedAttempts: Math.max(0, Number(state.failedAttempts) || 0),
    lockedUntil: state.lockedUntil ? Number(new Date(state.lockedUntil).getTime()) : 0,
    lastAttemptAt: state.lastAttemptAt ? Number(new Date(state.lastAttemptAt).getTime()) : 0,
    lastSuccessAt: state.lastSuccessAt ? Number(new Date(state.lastSuccessAt).getTime()) : 0
  };
}

function normalizeMongoResult(result) {
  return result?.value || result || null;
}

class PinLoginGuard {
  constructor({
    mongoStore = null,
    now = () => Date.now(),
    maxFailedAttempts = DEFAULT_MAX_FAILED_ATTEMPTS,
    lockoutMs = DEFAULT_LOCKOUT_MS
  } = {}) {
    this.mongoStore = mongoStore;
    this.now = now;
    this.maxFailedAttempts = Math.max(1, Number(maxFailedAttempts) || DEFAULT_MAX_FAILED_ATTEMPTS);
    this.lockoutMs = Math.max(1000, Number(lockoutMs) || DEFAULT_LOCKOUT_MS);
    this.memory = new Map();
  }

  async checkAllowed(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('PIN guard key is required');

    const now = this.now();
    const nowDate = new Date(now);
    const db = this.mongoStore?.isInitialized?.() ? this.mongoStore.getDb?.() : null;

    if (db) {
      const state = await db.collection(AUTH_SECURITY_COLLECTION).findOne({ _id: normalizedKey }) || {};
      const lockedUntil = state.lockedUntil ? new Date(state.lockedUntil).getTime() : 0;
      return {
        allowed: lockedUntil <= now,
        lockedUntil,
        failedAttempts: Math.max(0, Number(state.failedAttempts) || 0),
        retryAfterSeconds: lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0
      };
    }

    const current = cloneState(this.memory.get(normalizedKey));
    return {
      allowed: current.lockedUntil <= now,
      lockedUntil: current.lockedUntil,
      failedAttempts: current.failedAttempts,
      retryAfterSeconds: current.lockedUntil > now ? Math.ceil((current.lockedUntil - now) / 1000) : 0
    };
  }

  async recordFailure(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('PIN guard key is required');
    const now = this.now();
    const lockoutDate = new Date(now + this.lockoutMs);
    const db = this.mongoStore?.isInitialized?.() ? this.mongoStore.getDb?.() : null;

    if (db) {
      const currentAttempts = { $ifNull: ['$failedAttempts', 0] };
      const currentlyLocked = { $gt: [{ $ifNull: ['$lockedUntil', 0] }, new Date(now)] };
      const nextAttempts = {
        $cond: [currentlyLocked, currentAttempts, { $add: [currentAttempts, 1] }]
      };
      const nextLockedUntil = {
        $cond: [
          currentlyLocked,
          '$lockedUntil',
          {
            $cond: [
              { $gte: [nextAttempts, this.maxFailedAttempts] },
              lockoutDate,
              null
            ]
          }
        ]
      };
      const result = await db.collection(AUTH_SECURITY_COLLECTION).findOneAndUpdate(
        { _id: normalizedKey },
        [{
          $set: {
            failedAttempts: nextAttempts,
            lockedUntil: nextLockedUntil,
            lastAttemptAt: new Date(now)
          }
        }],
        { upsert: true, returnDocument: 'after' }
      );
      const state = normalizeMongoResult(result) || {};
      const lockedUntil = state.lockedUntil ? new Date(state.lockedUntil).getTime() : 0;
      return {
        locked: lockedUntil > now,
        lockedUntil,
        failedAttempts: Math.max(0, Number(state.failedAttempts) || 0),
        retryAfterSeconds: lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0
      };
    }

    const current = cloneState(this.memory.get(normalizedKey));
    if (current.lockedUntil > now) {
      return {
        locked: true,
        lockedUntil: current.lockedUntil,
        failedAttempts: current.failedAttempts,
        retryAfterSeconds: Math.ceil((current.lockedUntil - now) / 1000)
      };
    }
    current.failedAttempts += 1;
    current.lastAttemptAt = now;
    current.lockedUntil = current.failedAttempts >= this.maxFailedAttempts ? now + this.lockoutMs : 0;
    this.memory.set(normalizedKey, current);
    return {
      locked: current.lockedUntil > now,
      lockedUntil: current.lockedUntil,
      failedAttempts: current.failedAttempts,
      retryAfterSeconds: current.lockedUntil > now ? Math.ceil((current.lockedUntil - now) / 1000) : 0
    };
  }

  async recordSuccess(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return false;
    const now = this.now();
    const db = this.mongoStore?.isInitialized?.() ? this.mongoStore.getDb?.() : null;

    if (db) {
      const result = await db.collection(AUTH_SECURITY_COLLECTION).updateOne(
        {
          _id: normalizedKey,
          $or: [
            { lockedUntil: { $exists: false } },
            { lockedUntil: null },
            { lockedUntil: { $lte: new Date(now) } }
          ]
        },
        {
          $set: {
            failedAttempts: 0,
            lockedUntil: null,
            lastSuccessAt: new Date(now)
          }
        }
      );
      return Number(result?.matchedCount || 0) === 1;
    }

    const current = cloneState(this.memory.get(normalizedKey));
    if (current.lockedUntil > now) return false;
    current.failedAttempts = 0;
    current.lockedUntil = 0;
    current.lastSuccessAt = now;
    this.memory.set(normalizedKey, current);
    return true;
  }

  static keyFromScope(scope, secret = '') {
    const normalizedSecret = String(secret || 'pin-guard-dev-secret');
    return crypto.createHmac('sha256', normalizedSecret).update(`scope:${String(scope || 'unknown')}`).digest('hex');
  }

  static keyFromRequest(req, secret = '') {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const address = forwarded || req?.socket?.remoteAddress || 'unknown';
    const normalizedSecret = String(secret || 'pin-guard-dev-secret');
    return crypto.createHmac('sha256', normalizedSecret).update(String(address)).digest('hex');
  }
}

module.exports = {
  PinLoginGuard,
  AUTH_SECURITY_COLLECTION,
  DEFAULT_MAX_FAILED_ATTEMPTS,
  DEFAULT_LOCKOUT_MS
};
