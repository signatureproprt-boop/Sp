'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withWriteScope, currentWriteScope, recordWrite, waitForScopeWrites } = require('../src/data/writeScope');
const { confirmMongoPersistence } = require('../src/services/durableResponse');

test('a request waits for its own acknowledged writes without waiting for a later unrelated request', async () => {
  let finishFirst, finishOther, firstScope, otherScope;
  withWriteScope(() => { firstScope = currentWriteScope(); recordWrite(new Promise(resolve => { finishFirst = resolve; })); });
  withWriteScope(() => { otherScope = currentWriteScope(); recordWrite(new Promise(resolve => { finishOther = resolve; })); });
  const done = waitForScopeWrites(firstScope);
  finishFirst();
  assert.equal((await done).writeCount, 1);
  finishOther(); await waitForScopeWrites(otherScope);
  assert.equal(currentWriteScope(), undefined);
});

test('an unrelated failed request cannot turn a successful save into a failed acknowledgement', async () => {
  let failedScope, goodScope;
  const error = new Error('private failure payload'); error.code = 'CONCURRENT_CREATE_CONFLICT';
  withWriteScope(() => { failedScope = currentWriteScope(); recordWrite(Promise.reject(error)); });
  withWriteScope(() => { goodScope = currentWriteScope(); recordWrite(Promise.resolve()); });
  const [bad, good] = await Promise.all([
    confirmMongoPersistence({enabled:true,initialized:true,flush:()=>waitForScopeWrites(failedScope)}),
    confirmMongoPersistence({enabled:true,initialized:true,flush:()=>waitForScopeWrites(goodScope)})
  ]);
  assert.equal(bad.ok, false); assert.equal(bad.errorCode, 'CONCURRENT_CREATE_CONFLICT');
  assert.equal(good.ok, true); assert.doesNotMatch(JSON.stringify(bad), /private failure/);
});

test('asynchronous writes keep their originating request scope; read-only scopes have no writes', async () => {
  let scope;
  await withWriteScope(async () => { scope=currentWriteScope(); await Promise.resolve(); recordWrite(Promise.resolve()); });
  assert.equal((await waitForScopeWrites(scope)).writeCount,1);
  await withWriteScope(async () => { assert.equal((await waitForScopeWrites(currentWriteScope())).writeCount,0); });
});
