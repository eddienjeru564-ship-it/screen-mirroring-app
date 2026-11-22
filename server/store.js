// store.js — the small key/value store that holds all live session state.
//
// Interchangeable backends with the same async API:
//   MemoryStore   — in-process, used for `npm start` on a laptop and in tests.
//   UpstashStore  — Upstash Redis over its REST API, for Vercel, where each
//                   request may run in a different function instance and
//                   nothing can be kept in memory between requests.
//   SupabaseStore — the same operations in Supabase Postgres (one database
//                   function), the other option for Vercel.
//
// Only the handful of Redis operations ScreenView needs are implemented. Every
// value is a string; callers JSON-encode objects themselves.

/** In-process store with Redis-like semantics (strings, hashes, lists, expiry). */
export class MemoryStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {Map<string, {v: any, exp: number|null}>} */
    this.data = new Map();
  }

  #entry(key) {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.exp != null && this.now() >= e.exp) {
      this.data.delete(key);
      return null;
    }
    return e;
  }

  async get(key) {
    const e = this.#entry(key);
    return e && typeof e.v === 'string' ? e.v : null;
  }

  /** SET key value [PX ms] [NX]. Returns true if the value was written. */
  async set(key, value, { px, nx } = {}) {
    if (nx && this.#entry(key)) return false;
    this.data.set(key, { v: String(value), exp: px ? this.now() + px : null });
    return true;
  }

  async del(...keys) {
    for (const k of keys) this.data.delete(k);
  }

  async pexpire(key, ms) {
    const e = this.#entry(key);
    if (e) e.exp = this.now() + ms;
  }

  /** Remaining lifetime in ms (-1 no expiry, -2 missing), like Redis PTTL. */
  async pttl(key) {
    const e = this.#entry(key);
    if (!e) return -2;
    return e.exp == null ? -1 : Math.max(0, e.exp - this.now());
  }

  /** INCR; on the first increment also sets an expiry of `px` ms. */
  async incr(key, px) {
    const e = this.#entry(key);
    const n = (e ? Number(e.v) : 0) + 1;
    this.data.set(key, { v: String(n), exp: e ? e.exp : px ? this.now() + px : null });
    return n;
  }

  async hset(key, field, value, px) {
    let e = this.#entry(key);
    if (!e) {
      e = { v: new Map(), exp: null };
      this.data.set(key, e);
    }
    e.v.set(field, String(value));
    if (px) e.exp = this.now() + px;
  }

  async hgetall(key) {
    const e = this.#entry(key);
    return e ? Object.fromEntries(e.v) : {};
  }

  /** Append to a list, refreshing its expiry. Optionally keep only the last `max` items. */
  async rpush(key, value, { px, max } = {}) {
    let e = this.#entry(key);
    if (!e) {
      e = { v: [], exp: null };
      this.data.set(key, e);
    }
    e.v.push(String(value));
    if (max && e.v.length > max) e.v.splice(0, e.v.length - max);
    if (px) e.exp = this.now() + px;
  }

  async lrange(key) {
    const e = this.#entry(key);
    return e ? [...e.v] : [];
  }

  /** Atomically read and empty a list (a mailbox). */
  async drain(key) {
    const e = this.#entry(key);
    if (!e) return [];
    this.data.delete(key);
    return e.v;
  }
}

/**
 * Upstash Redis via its REST API (https://upstash.com/docs/redis/features/restapi).
 * Uses plain fetch, so no extra dependency and no TCP connection to keep alive
 * across serverless invocations.
 */
export class UpstashStore {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #post(path, body) {
    const res = await this.fetch(this.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json == null) {
      throw new Error(`Upstash ${res.status}: ${json?.error || 'request failed'}`);
    }
    return json;
  }

  /** Run one Redis command, e.g. cmd('SET', 'k', 'v'). */
  async cmd(...args) {
    const json = await this.#post('', args.map(String));
    if (json.error) throw new Error(`Upstash: ${json.error}`);
    return json.result;
  }

  /** Run several commands atomically (MULTI/EXEC); returns their results. */
  async multi(commands) {
    const json = await this.#post('/multi-exec', commands.map((c) => c.map(String)));
    return json.map((r) => {
      if (r.error) throw new Error(`Upstash: ${r.error}`);
      return r.result;
    });
  }

  async get(key) {
    return this.cmd('GET', key);
  }

  async set(key, value, { px, nx } = {}) {
    const args = ['SET', key, value];
    if (px) args.push('PX', px);
    if (nx) args.push('NX');
    return (await this.cmd(...args)) === 'OK';
  }

  async del(...keys) {
    if (keys.length) await this.cmd('DEL', ...keys);
  }

  async pexpire(key, ms) {
    await this.cmd('PEXPIRE', key, ms);
  }

  async pttl(key) {
    return Number(await this.cmd('PTTL', key));
  }

  async incr(key, px) {
    const n = Number(await this.cmd('INCR', key));
    if (n === 1 && px) await this.pexpire(key, px); // window starts at the first hit
    return n;
  }

  async hset(key, field, value, px) {
    const cmds = [['HSET', key, field, value]];
    if (px) cmds.push(['PEXPIRE', key, px]);
    await this.multi(cmds);
  }

  async hgetall(key) {
    const flat = (await this.cmd('HGETALL', key)) || [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }

  async rpush(key, value, { px, max } = {}) {
    const cmds = [['RPUSH', key, value]];
    if (max) cmds.push(['LTRIM', key, -max, -1]);
    if (px) cmds.push(['PEXPIRE', key, px]);
    await this.multi(cmds);
  }

  async lrange(key) {
    return (await this.cmd('LRANGE', key, 0, -1)) || [];
  }

  async drain(key) {
    const [items] = await this.multi([['LRANGE', key, 0, -1], ['DEL', key]]);
    return items || [];
  }
}

/**
 * Supabase (Postgres) via its REST API. Every operation is one call to the
 * screenview_exec() database function (supabase/migrations/0001_screenview_store.sql),
 * which runs it as a single atomic statement. The function refuses calls
 * without the store secret, so the publishable key alone gives no access.
 */
export class SupabaseStore {
  constructor({ url, key, secret, fetchImpl = globalThis.fetch, now = null }) {
    this.endpoint = url.replace(/\/+$/, '') + '/rest/v1/rpc/screenview_exec';
    this.key = key;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.now = now; // tests only: a fake clock passed through to the function
  }

  async cmd(...args) {
    const body = { p_secret: this.secret, p_cmd: args };
    if (this.now) body.p_now = this.now();
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok || json === undefined) {
      throw new Error(`Supabase ${res.status}: ${json?.message || 'request failed'}`);
    }
    return json;
  }

  async get(key) {
    return this.cmd('get', key);
  }

  async set(key, value, { px, nx } = {}) {
    return (await this.cmd('set', key, String(value), px || null, !!nx)) === true;
  }

  async del(...keys) {
    if (keys.length) await this.cmd('del', ...keys);
  }

  async pexpire(key, ms) {
    await this.cmd('pexpire', key, ms);
  }

  async pttl(key) {
    return Number(await this.cmd('pttl', key));
  }

  async incr(key, px) {
    return Number(await this.cmd('incr', key, px || null));
  }

  async hset(key, field, value, px) {
    await this.cmd('hset', key, field, String(value), px || null);
  }

  async hgetall(key) {
    return (await this.cmd('hgetall', key)) || {};
  }

  async rpush(key, value, { px, max } = {}) {
    await this.cmd('rpush', key, String(value), px || null, max || null);
  }

  async lrange(key) {
    return (await this.cmd('lrange', key)) || [];
  }

  async drain(key) {
    return (await this.cmd('drain', key)) || [];
  }
}

/**
 * Pick the store from the environment: Upstash when its REST URL and token are
 * present (KV_REST_API_* or UPSTASH_REDIS_REST_*), else Supabase when
 * SUPABASE_URL, a publishable/anon key and SCREENVIEW_STORE_SECRET are set,
 * else memory.
 */
export function storeFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return { store: new UpstashStore({ url, token }), kind: 'upstash' };
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const secret = env.SCREENVIEW_STORE_SECRET;
  if (sbUrl && sbKey && secret) {
    return { store: new SupabaseStore({ url: sbUrl, key: sbKey, secret }), kind: 'supabase' };
  }
  return { store: new MemoryStore(), kind: 'memory' };
}
