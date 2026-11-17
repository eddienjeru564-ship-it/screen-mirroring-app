import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../server/rateLimit.js';
import { MemoryStore } from '../../server/store.js';

test('limits after max failures inside the window', async () => {
  const t = 0;
  const rl = new RateLimiter({ store: new MemoryStore({ now: () => t }), max: 5, windowMs: 60_000 });
  for (let i = 0; i < 4; i++) {
    await rl.recordFailure('ip');
    assert.equal(await rl.isLimited('ip'), false);
  }
  assert.equal(await rl.recordFailure('ip'), true);
  assert.equal(await rl.isLimited('ip'), true);
  assert.ok((await rl.retryAfterMs('ip')) > 0);
});

test('the window expires and the IP may try again', async () => {
  let t = 0;
  const rl = new RateLimiter({ store: new MemoryStore({ now: () => t }), max: 2, windowMs: 1000 });
  await rl.recordFailure('ip');
  await rl.recordFailure('ip');
  assert.equal(await rl.isLimited('ip'), true);
  t = 1000;
  assert.equal(await rl.isLimited('ip'), false);
  assert.equal(await rl.retryAfterMs('ip'), 0);
});

test('IPs are independent and reset clears', async () => {
  const rl = new RateLimiter({ store: new MemoryStore(), max: 1, windowMs: 1000 });
  await rl.recordFailure('a');
  assert.equal(await rl.isLimited('a'), true);
  assert.equal(await rl.isLimited('b'), false);
  await rl.reset('a');
  assert.equal(await rl.isLimited('a'), false);
});
