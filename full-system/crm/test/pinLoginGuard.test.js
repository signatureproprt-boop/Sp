'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PinLoginGuard } = require('../src/services/pinLoginGuard');

function makeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; }
  };
}

test('PIN guard allows four failures and locks on the fifth', async () => {
  const clock = makeClock();
  const guard = new PinLoginGuard({ now: clock.now, lockoutMs: 900_000 });

  for (let i = 1; i <= 4; i += 1) {
    assert.equal((await guard.checkAllowed('ip-a')).allowed, true);
    const failure = await guard.recordFailure('ip-a');
    assert.equal(failure.locked, false);
    assert.equal(failure.failedAttempts, i);
  }

  const fifth = await guard.recordFailure('ip-a');
  assert.equal(fifth.locked, true);
  assert.equal(fifth.failedAttempts, 5);
  assert.equal((await guard.checkAllowed('ip-a')).allowed, false);
});

test('locked PIN guard remains blocked until cooldown expires', async () => {
  const clock = makeClock();
  const guard = new PinLoginGuard({ now: clock.now, lockoutMs: 900_000 });

  for (let i = 0; i < 5; i += 1) {
    await guard.recordFailure('ip-a');
  }

  assert.equal((await guard.checkAllowed('ip-a')).allowed, false);
  assert.equal(await guard.recordSuccess('ip-a'), false);

  clock.advance(900_001);
  assert.equal((await guard.checkAllowed('ip-a')).allowed, true);
  assert.equal(await guard.recordSuccess('ip-a'), true);
});

test('successful PIN resets failure counter', async () => {
  const clock = makeClock();
  const guard = new PinLoginGuard({ now: clock.now, lockoutMs: 900_000 });

  for (let i = 0; i < 4; i += 1) {
    await guard.recordFailure('ip-a');
  }

  assert.equal(await guard.recordSuccess('ip-a'), true);
  const nextFailure = await guard.recordFailure('ip-a');
  assert.equal(nextFailure.failedAttempts, 1);
  assert.equal(nextFailure.locked, false);
});

test('different keys have independent lockouts', async () => {
  const guard = new PinLoginGuard({ now: () => 1_000_000, lockoutMs: 900_000 });

  for (let i = 0; i < 5; i += 1) {
    await guard.recordFailure('ip-a');
  }

  assert.equal((await guard.checkAllowed('ip-a')).allowed, false);
  assert.equal((await guard.checkAllowed('ip-b')).allowed, true);
});

test('request key is deterministic and does not expose raw IP', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  const key = PinLoginGuard.keyFromRequest(req, 'test-secret');
  assert.equal(key.length, 64);
  assert.equal(key.includes('203.0.113.10'), false);
  assert.equal(key, PinLoginGuard.keyFromRequest(req, 'test-secret'));
});
