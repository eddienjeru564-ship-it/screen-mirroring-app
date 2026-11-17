// A tiny stand-in for Upstash's REST API, used to test UpstashStore without a
// real Redis. It parses the same JSON request bodies Upstash accepts and
// answers in the same {result} / [{result}] shapes, implementing only the
// commands ScreenView uses, with Redis semantics (including expiry).

import { MemoryStore, UpstashStore } from '../../server/store.js';

/** Both store backends, for running one test suite against each. */
export function backends() {
  return [
    ['memory', (now) => new MemoryStore({ now })],
    ['upstash', (now) => new UpstashStore({
      url: 'https://fake.upstash.io/', token: 'test-token', fetchImpl: fakeUpstash({ now }).fetchImpl,
    })],
  ];
}

export function fakeUpstash({ now = Date.now, token = 'test-token' } = {}) {
  const db = new Map(); // key -> {v, exp}
  let requests = 0;

  const live = (k) => {
    const e = db.get(k);
    if (e && e.exp != null && now() >= e.exp) {
      db.delete(k);
      return null;
    }
    return e || null;
  };

  function run([name, ...a]) {
    const cmd = name.toUpperCase();
    switch (cmd) {
      case 'GET': {
        const e = live(a[0]);
        if (e && typeof e.v !== 'string') throw new Error('WRONGTYPE');
        return e ? e.v : null;
      }
      case 'SET': {
        const [k, v, ...opts] = a;
        let px = null;
        let nx = false;
        for (let i = 0; i < opts.length; i++) {
          const o = opts[i].toUpperCase();
          if (o === 'PX') px = Number(opts[++i]);
          else if (o === 'NX') nx = true;
          else throw new Error('ERR syntax error');
        }
        if (nx && live(k)) return null;
        db.set(k, { v, exp: px ? now() + px : null });
        return 'OK';
      }
      case 'DEL': {
        let n = 0;
        for (const k of a) if (live(k) && db.delete(k)) n++;
        return n;
      }
      case 'PEXPIRE': {
        const e = live(a[0]);
        if (!e) return 0;
        e.exp = now() + Number(a[1]);
        return 1;
      }
      case 'PTTL': {
        const e = live(a[0]);
        if (!e) return -2;
        return e.exp == null ? -1 : e.exp - now();
      }
      case 'INCR': {
        const e = live(a[0]);
        const n = (e ? Number(e.v) : 0) + 1;
        db.set(a[0], { v: String(n), exp: e ? e.exp : null });
        return n;
      }
      case 'HSET': {
        let e = live(a[0]);
        if (!e) db.set(a[0], (e = { v: new Map(), exp: null }));
        for (let i = 1; i < a.length; i += 2) e.v.set(a[i], a[i + 1]);
        return 1;
      }
      case 'HGETALL': {
        const e = live(a[0]);
        return e ? [...e.v].flat() : [];
      }
      case 'RPUSH': {
        let e = live(a[0]);
        if (!e) db.set(a[0], (e = { v: [], exp: null }));
        e.v.push(...a.slice(1));
        return e.v.length;
      }
      case 'LTRIM': {
        const e = live(a[0]);
        if (!e) return 'OK';
        const len = e.v.length;
        let start = Number(a[1]);
        let stop = Number(a[2]);
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        e.v = e.v.slice(start, stop + 1);
        return 'OK';
      }
      case 'LRANGE': {
        const e = live(a[0]);
        if (!e) return [];
        const stop = Number(a[2]) < 0 ? e.v.length + Number(a[2]) : Number(a[2]);
        return e.v.slice(Number(a[1]), stop + 1);
      }
      default:
        throw new Error(`ERR unknown command '${name}'`);
    }
  }

  async function fetchImpl(url, init) {
    requests++;
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `Bearer ${token}`) return json(401, { error: 'Unauthorized' });
    const body = JSON.parse(init.body);
    for (const part of [body].flat(2)) {
      if (typeof part !== 'string') return json(400, { error: 'ERR arguments must be strings' });
    }
    if (url.endsWith('/multi-exec')) {
      return json(200, body.map((c) => ({ result: run(c) })));
    }
    try {
      return json(200, { result: run(body) });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  return { fetchImpl, get requests() { return requests; } };
}
