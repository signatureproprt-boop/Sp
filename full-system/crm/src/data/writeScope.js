'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();

function withWriteScope(action) { return storage.run({ writes: [] }, action); }
function currentWriteScope() { return storage.getStore(); }
function recordWrite(promise) {
  const scope = currentWriteScope();
  if (scope) scope.writes.push(promise);
}
async function waitForScopeWrites(scope) {
  const writes = scope.writes.slice();
  const results = await Promise.allSettled(writes);
  const rejected = results.find(result => result.status === 'rejected');
  return { writeCount: writes.length, failures: rejected ? 1 : 0,
    lastError: rejected ? 'write_failed' : null,
    lastErrorCode: rejected?.reason?.code || null };
}
module.exports = { withWriteScope, currentWriteScope, recordWrite, waitForScopeWrites };
