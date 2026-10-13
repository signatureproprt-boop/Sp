'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForPostSaveReport } = require('../src/services/durableResponse');

test('durable CRM response is released when optional reporting is stuck', async () => {
  let finish;
  const work = new Promise(resolve => { finish = resolve; });
  const result = await waitForPostSaveReport(() => work, 10);
  assert.equal(result.state, 'PENDING');
  assert.equal(result.ok, false);
  // Reporting remains live and can finish later; no second run is started.
  finish({ ok: true, state: 'SYNCED' });
  assert.equal((await work).state, 'SYNCED');
});

test('completed report result is retained and reporting failure cannot reject a CRM response', async () => {
  const result = { ok: true, state: 'SYNCED' };
  assert.deepEqual(await waitForPostSaveReport(() => result), result);
  for (const run of [() => { throw new Error('private upstream payload'); }, () => Promise.reject(new Error('private token'))]) {
    const failure = await waitForPostSaveReport(run);
    assert.equal(failure.state, 'ERROR');
    assert.equal(JSON.stringify(failure).includes('private'), false);
  }
});
