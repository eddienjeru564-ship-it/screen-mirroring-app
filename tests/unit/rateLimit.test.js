import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../server/rateLimit.js';

test('limits after max failures inside the window', () => {
  let t = 0;
  const rl = new RateLimiter({ max: 5, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 4; i++) {
    rl.recordFailure('ip');
    assert.equal(rl.isLimited('ip'), false);
  }
  rl.recordFailure('ip');
  assert.equal(rl.isLimited('ip'), true);
  assert.ok(rl.retryAfterMs('ip') > 0);
});

test('window slides: old failures expire', () => {
  let t = 0;
  const rl = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
  rl.recordFailure('ip');
  rl.recordFailure('ip');
  assert.equal(rl.isLimited('ip'), true);
  t = 1001;
  assert.equal(rl.isLimited('ip'), false);
  assert.equal(rl.retryAfterMs('ip'), 0);
});

test('keys are independent and reset clears', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  rl.recordFailure('a');
  assert.equal(rl.isLimited('a'), true);
  assert.equal(rl.isLimited('b'), false);
  rl.reset('a');
  assert.equal(rl.isLimited('a'), false);
});
