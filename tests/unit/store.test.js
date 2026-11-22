// The same behaviour tests run against every store backend, so the in-memory
// store used locally and the Upstash and Supabase stores used on Vercel behave
// identically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpstashStore, SupabaseStore, storeFromEnv } from '../../server/store.js';
import { fakeUpstash, backends } from './fakeUpstash.js';
import { fakeSupabase, TEST_KEY } from './fakeSupabase.js';

for (const [name, make] of backends()) {
  test(`${name}: get/set with NX and expiry`, async () => {
    let t = 0;
    const s = make(() => t);
    assert.equal(await s.get('k'), null);
    assert.equal(await s.set('k', 'a', { nx: true }), true);
    assert.equal(await s.set('k', 'b', { nx: true }), false);
    assert.equal(await s.get('k'), 'a');
    await s.set('t', 'x', { px: 1000 });
    assert.ok((await s.pttl('t')) > 0);
    t = 1000;
    assert.equal(await s.get('t'), null);
    assert.equal(await s.pttl('t'), -2);
    await s.del('k');
    assert.equal(await s.get('k'), null);
  });

  test(`${name}: incr starts a window on the first hit`, async () => {
    let t = 0;
    const s = make(() => t);
    assert.equal(await s.incr('c', 500), 1);
    assert.equal(await s.incr('c', 500), 2);
    t = 499;
    assert.equal(await s.get('c'), '2');
    t = 500;
    assert.equal(await s.get('c'), null);
    assert.equal(await s.incr('c', 500), 1);
  });

  test(`${name}: hashes`, async () => {
    const s = make(() => 0);
    assert.deepEqual(await s.hgetall('h'), {});
    await s.hset('h', 'a', '1');
    await s.hset('h', 'b', '2', 10_000);
    await s.hset('h', 'a', '3');
    assert.deepEqual(await s.hgetall('h'), { a: '3', b: '2' });
  });

  test(`${name}: lists, capped lists and atomic drain`, async () => {
    const s = make(() => 0);
    assert.deepEqual(await s.drain('m'), []);
    await s.rpush('m', 'x', { px: 10_000 });
    await s.rpush('m', 'y');
    assert.deepEqual(await s.lrange('m'), ['x', 'y']);
    assert.deepEqual(await s.drain('m'), ['x', 'y']);
    assert.deepEqual(await s.lrange('m'), []);
    for (let i = 0; i < 5; i++) await s.rpush('log', String(i), { max: 3 });
    assert.deepEqual(await s.lrange('log'), ['2', '3', '4']);
  });
}

test('upstash: a bad token surfaces as an error, not silent data loss', async () => {
  const s = new UpstashStore({ url: 'https://x', token: 'wrong', fetchImpl: fakeUpstash().fetchImpl });
  await assert.rejects(() => s.get('k'), /401/);
});

test('supabase: a wrong store secret is refused by the database function', async () => {
  const { fetchImpl } = fakeSupabase();
  const bad = new SupabaseStore({ url: 'https://x', key: TEST_KEY, secret: 'guess', fetchImpl });
  await assert.rejects(() => bad.get('k'), /401.*unauthorized/);
  const noKey = new SupabaseStore({ url: 'https://x', key: 'wrong', secret: 'guess', fetchImpl });
  await assert.rejects(() => noKey.get('k'), /401/);
});

test('storeFromEnv picks Upstash only when URL and token are both set', () => {
  assert.equal(storeFromEnv({}).kind, 'memory');
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://x' }).kind, 'memory');
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).kind, 'upstash');
  assert.equal(
    storeFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }).kind,
    'upstash',
  );
  const sb = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k' };
  assert.equal(storeFromEnv(sb).kind, 'memory'); // no secret, no Supabase
  assert.equal(storeFromEnv({ ...sb, SCREENVIEW_STORE_SECRET: 's' }).kind, 'supabase');
});
