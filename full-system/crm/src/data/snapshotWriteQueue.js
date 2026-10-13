'use strict';

// Only waiting snapshots are coalesced. A snapshot already being persisted is
// immutable, and every caller waits for the batch containing its change.
function createSnapshotWriteQueue(persist) {
  let waiting = null;
  let tail = Promise.resolve();
  function enqueue(base, desired) {
    if (waiting) {
      waiting.desired = desired;
      return waiting.promise;
    }
    const batch = { base, desired, promise: null };
    waiting = batch;
    const task = tail.catch(() => {}).then(() => {
      if (waiting === batch) waiting = null;
      return persist(batch.base, batch.desired);
    });
    batch.promise = task;
    tail = task;
    return task;
  }
  return { enqueue };
}

module.exports = { createSnapshotWriteQueue };
