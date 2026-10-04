'use strict';

async function confirmMongoPersistence({ enabled, initialized, failureBaseline = 0, flush } = {}) {
  if (!enabled || !initialized) return { ok: true, skipped: true };
  if (typeof flush !== 'function') return { ok: false, error: 'flush_unavailable' };

  try {
    const stats = await flush();
    const failed = Boolean(stats?.lastError) || Number(stats?.failures || 0) > Number(failureBaseline || 0);
    return { ok: !failed, skipped: false };
  } catch (_) {
    return { ok: false, skipped: false, error: 'flush_failed' };
  }
}

module.exports = { confirmMongoPersistence };
