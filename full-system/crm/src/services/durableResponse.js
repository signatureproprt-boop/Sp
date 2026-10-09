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

// Optional external reporting must not hold a durably saved CRM change open.
// The runner continues its existing work and retry schedule after this deadline.
async function waitForPostSaveReport(run, timeoutMs = 2000) {
  let timer;
  const pending = { ok: false, state: 'PENDING', message: 'CRM saved; report update is pending.' };
  const completed = Promise.resolve().then(run).catch(() => ({
    ok: false, state: 'ERROR', message: 'CRM saved; report update failed.'
  }));
  try {
    return await Promise.race([
      completed,
      new Promise(resolve => { timer = setTimeout(() => resolve(pending), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { confirmMongoPersistence, waitForPostSaveReport };
