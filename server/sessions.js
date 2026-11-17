// sessions.js — session, join-code and signaling logic on top of the store.
//
// Stateless by design: every method reads what it needs from the store and
// writes changes back, so any server instance can handle any request (this is
// what makes it work on Vercel's serverless functions). Time is injected
// (`now`) so tests can control expiry.
//
// Store layout (all keys expire on their own; nothing needs a cleanup job):
//   sv:s:{sid}     session record (JSON): code, hostToken, passwordHash, ...
//   sv:c:{code}    code -> sid while the code is joinable
//   sv:d:{code}    "dead" code -> end reason, kept 1 h so late viewers get an
//                  accurate "expired"/"ended" message instead of "invalid"
//   sv:e:{sid}     end reason; written once (NX), so the first ending wins
//   sv:q:{sid}     current quality preset
//   sv:fv:{sid}    set when the first viewer joins (stops the expiry clock)
//   sv:hs:{sid}    host last-seen time
//   sv:v:{sid}     hash viewerId -> {token, joinedAt, left}
//   sv:vs:{sid}    hash viewerId -> last-seen time
//   sv:m:{sid}:{to} mailbox (list) for "host" or a viewerId
//   sv:lock:{sid}  short lock around joins so two viewers can't both take the last seat
//
// "Connected" means "has polled recently": the browsers poll every ~2 s, a
// viewer silent for VIEWER_STALE_MS counts as gone, and a host silent for
// GRACE_MS ends the session (host_timeout).

import { randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

/** How long ended sessions' codes are remembered (for accurate errors). */
export const RETAIN_ENDED_MS = 60 * 60 * 1000;
/** Hard upper bound on any key's lifetime. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Generate a 6-digit code as a zero-padded string, e.g. "482913". */
function rawCode() {
  // crypto.randomInt is uniform and not sequentially guessable.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Pretty form "482-913" for display. */
export function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Strip anything that isn't a digit (so "482-913", "482 913" all normalise). */
export function normaliseCode(input) {
  return String(input ?? '').replace(/\D/g, '');
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Constant-time string comparison (tokens, password hashes). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

const QUALITIES = ['low', 'medium', 'high'];
const isQuality = (q) => QUALITIES.includes(q);

export class SessionService {
  /**
   * @param {object} opts
   * @param {object} opts.store            MemoryStore | UpstashStore
   * @param {object} opts.logger           SessionLogger
   * @param {number} [opts.codeExpiryMs]   unused-code lifetime
   * @param {number} [opts.graceMs]        how long the host may be silent
   * @param {number} [opts.viewerStaleMs]  how long a viewer may be silent
   * @param {number} [opts.maxViewers]     viewers per session (1..3)
   * @param {() => number} [opts.now]
   */
  constructor({
    store,
    logger,
    codeExpiryMs = 10 * 60 * 1000,
    graceMs = 60 * 1000,
    viewerStaleMs = 12 * 1000,
    maxViewers = 1,
    now = Date.now,
  }) {
    this.store = store;
    this.logger = logger;
    this.codeExpiryMs = codeExpiryMs;
    this.graceMs = graceMs;
    this.viewerStaleMs = viewerStaleMs;
    this.maxViewers = Math.min(Math.max(maxViewers || 1, 1), 3);
    this.now = now;
  }

  /** How often clients should poll when nothing is happening. */
  get idlePollMs() {
    return Math.max(500, Math.min(2500, Math.floor(this.viewerStaleMs / 3)));
  }

  // ---------- record helpers ----------

  async #session(sid) {
    if (typeof sid !== 'string' || !sid) return null;
    const raw = await this.store.get(`sv:s:${sid}`);
    return raw ? JSON.parse(raw) : null;
  }

  async #viewers(sid) {
    const [recs, seen] = await Promise.all([
      this.store.hgetall(`sv:v:${sid}`),
      this.store.hgetall(`sv:vs:${sid}`),
    ]);
    const out = new Map();
    for (const [id, raw] of Object.entries(recs)) {
      out.set(id, { ...JSON.parse(raw), seen: Number(seen[id] || 0) });
    }
    return out;
  }

  #isActive(v) {
    return !v.left && this.now() - v.seen < this.viewerStaleMs;
  }

  async #putViewer(sid, viewerId, v) {
    const { token, joinedAt, left, leftOnPurpose = false } = v;
    const rec = JSON.stringify({ token, joinedAt, left, leftOnPurpose: left && leftOnPurpose });
    await this.store.hset(`sv:v:${sid}`, viewerId, rec, SESSION_TTL_MS);
  }

  async #touchViewer(sid, viewerId) {
    await this.store.hset(`sv:vs:${sid}`, viewerId, String(this.now()), SESSION_TTL_MS);
  }

  async #send(sid, to, message) {
    await this.store.rpush(`sv:m:${sid}:${to}`, JSON.stringify(message), { px: SESSION_TTL_MS });
  }

  async #drain(sid, to) {
    return (await this.store.drain(`sv:m:${sid}:${to}`)).map((s) => JSON.parse(s));
  }

  // ---------- lifecycle ----------

  /** Create a session for a host. */
  async createSession({ password = null, quality = 'medium' } = {}) {
    const sessionId = randomUUID();
    let code;
    for (let i = 0; ; i++) {
      code = rawCode();
      // Skip codes that are live OR recently ended, so a dead code really stays dead.
      if (!(await this.store.get(`sv:d:${code}`))
          && (await this.store.set(`sv:c:${code}`, sessionId, { px: SESSION_TTL_MS, nx: true }))) break;
      if (i > 50) throw new Error('could not allocate a join code');
    }
    const t = this.now();
    const q = isQuality(quality) ? quality : 'medium';
    const session = {
      sessionId,
      code,
      hostToken: randomUUID(),
      passwordHash: password ? sha256(password) : null,
      createdAt: t,
      expiresAt: t + this.codeExpiryMs,
    };
    await Promise.all([
      this.store.set(`sv:s:${sessionId}`, JSON.stringify(session), { px: SESSION_TTL_MS }),
      this.store.set(`sv:q:${sessionId}`, q, { px: SESSION_TTL_MS }),
      this.store.set(`sv:hs:${sessionId}`, String(t), { px: SESSION_TTL_MS }),
    ]);
    await this.logger.sessionStart({ sessionId, code, hasPassword: !!password, quality: q });
    return {
      sessionId,
      code,
      codePretty: formatCode(code),
      hostToken: session.hostToken,
      quality: q,
      hasPassword: !!password,
      expiresInMs: this.codeExpiryMs,
    };
  }

  /**
   * End a session for good. Only the first call wins (NX). Viewers still
   * connected are logged as leaving, and the code becomes dead.
   * Returns true if this call ended it.
   */
  async endSession(sid, reason) {
    const session = await this.#session(sid);
    if (!session) return false;
    const won = await this.store.set(`sv:e:${sid}`, reason, { px: SESSION_TTL_MS, nx: true });
    if (!won) return false;
    for (const [viewerId, v] of await this.#viewers(sid)) {
      if (!v.left) {
        await this.#putViewer(sid, viewerId, { ...v, left: true });
        await this.logger.viewerLeave(sid, viewerId);
      }
    }
    if ((await this.store.get(`sv:c:${session.code}`)) === sid) await this.store.del(`sv:c:${session.code}`);
    await this.store.set(`sv:d:${session.code}`, reason, { px: RETAIN_ENDED_MS });
    await this.logger.sessionEnd({
      sessionId: sid,
      code: session.code,
      endReason: reason,
      startedAt: session.createdAt,
      endedAt: this.now(),
    });
    return true;
  }

  /**
   * Apply the time-based rules lazily (there is no background timer on
   * serverless): an unused code past its expiry, or a host silent for longer
   * than the grace period, ends the session. Returns the end reason or null.
   */
  async #checkEnded(session) {
    const sid = session.sessionId;
    const ended = await this.store.get(`sv:e:${sid}`);
    if (ended) return ended;
    const t = this.now();
    if (t >= session.expiresAt && !(await this.store.get(`sv:fv:${sid}`))) {
      await this.endSession(sid, 'expired');
    } else if (t - Number((await this.store.get(`sv:hs:${sid}`)) || 0) > this.graceMs) {
      await this.endSession(sid, 'host_timeout');
    } else {
      return null;
    }
    return this.store.get(`sv:e:${sid}`);
  }

  async #verifyHost(sid, hostToken) {
    const session = await this.#session(sid);
    return session && safeEqual(session.hostToken, hostToken) ? session : null;
  }

  async #verifyViewer(sid, viewerId, viewerToken) {
    const session = await this.#session(sid);
    if (!session || typeof viewerId !== 'string') return null;
    const raw = (await this.store.hgetall(`sv:v:${sid}`))[viewerId];
    if (!raw || !safeEqual(JSON.parse(raw).token, viewerToken)) return null;
    return session;
  }

  // ---------- viewer ----------

  /**
   * Attempt to add a viewer by code (+ optional password).
   * Returns { ok: true, sessionId, viewerId, viewerToken } or { ok: false, error }.
   * error ∈ invalid_code | expired | ended | wrong_password | session_full | busy
   */
  async joinByCode(codeInput, password = null) {
    const code = normaliseCode(codeInput);
    const sid = code.length === 6 ? await this.store.get(`sv:c:${code}`) : null;
    const session = sid ? await this.#session(sid) : null;
    if (!session) {
      const dead = code.length === 6 ? await this.store.get(`sv:d:${code}`) : null;
      if (!dead) return { ok: false, error: 'invalid_code' };
      return { ok: false, error: dead === 'expired' ? 'expired' : 'ended' };
    }
    const ended = await this.#checkEnded(session);
    if (ended) return { ok: false, error: ended === 'expired' ? 'expired' : 'ended' };
    if (session.passwordHash && !safeEqual(session.passwordHash, sha256(password ?? ''))) {
      return { ok: false, error: 'wrong_password' };
    }

    // Short lock so two simultaneous joins can't both take the last seat.
    const lockKey = `sv:lock:${sid}`;
    let locked = false;
    for (let i = 0; i < 20 && !locked; i++) {
      locked = await this.store.set(lockKey, '1', { px: 5000, nx: true });
      if (!locked) await new Promise((r) => setTimeout(r, 50));
    }
    if (!locked) return { ok: false, error: 'busy' };
    try {
      let active = 0;
      for (const v of (await this.#viewers(sid)).values()) if (this.#isActive(v)) active++;
      if (active >= this.maxViewers) return { ok: false, error: 'session_full' };

      const viewerId = randomUUID();
      const viewerToken = randomUUID();
      await this.#putViewer(sid, viewerId, { token: viewerToken, joinedAt: this.now(), left: false });
      await this.#touchViewer(sid, viewerId);
      await this.store.set(`sv:fv:${sid}`, '1', { px: SESSION_TTL_MS, nx: true });
      await this.logger.viewerJoin(sid, viewerId);
      await this.#send(sid, 'host', { type: 'viewer:joined', viewerId });
      return { ok: true, sessionId: sid, viewerId, viewerToken };
    } finally {
      await this.store.del(lockKey);
    }
  }

  /**
   * Viewer heartbeat + inbox. If the viewer had been counted as gone (silent
   * too long), it is brought back and the host is asked to send a fresh offer:
   * the viewer never has to type the code again.
   */
  async viewerPoll({ sessionId, viewerId, viewerToken }) {
    const session = await this.#verifyViewer(sessionId, viewerId, viewerToken);
    if (!session) return { ok: false, error: 'not_found' };
    const ended = await this.#checkEnded(session);
    if (ended) return { ok: true, ended };

    const v = (await this.#viewers(sessionId)).get(viewerId);
    if (v.left) {
      // Explicitly left (Leave button) stays left; only a timeout can be undone.
      if (v.leftOnPurpose) return { ok: true, ended: 'left' };
      await this.#putViewer(sessionId, viewerId, { ...v, left: false });
    }
    await this.#touchViewer(sessionId, viewerId);
    let events = await this.#drain(sessionId, viewerId);
    let rejoined = false;
    if (v.left) {
      rejoined = true;
      events = []; // anything queued was for the old connection
      await this.#send(sessionId, 'host', { type: 'viewer:joined', viewerId, rejoin: true });
    }
    return {
      ok: true,
      events,
      rejoined,
      quality: await this.store.get(`sv:q:${sessionId}`),
      pollMs: this.idlePollMs,
    };
  }

  /** Viewer pressed Leave or closed the tab. */
  async viewerLeave({ sessionId, viewerId, viewerToken }) {
    if (!(await this.#verifyViewer(sessionId, viewerId, viewerToken))) return { ok: false };
    const v = (await this.#viewers(sessionId)).get(viewerId);
    if (!v.left) {
      await this.#putViewer(sessionId, viewerId, { ...v, left: true, leftOnPurpose: true });
      await this.logger.viewerLeave(sessionId, viewerId);
      await this.#send(sessionId, 'host', { type: 'viewer:left', viewerId });
    }
    return { ok: true };
  }

  // ---------- host ----------

  /** Host heartbeat + inbox, plus viewer count and viewers that went silent. */
  async hostPoll({ sessionId, hostToken }) {
    const session = await this.#verifyHost(sessionId, hostToken);
    if (!session) return { ok: false, error: 'not_found' };
    // Check BEFORE refreshing last-seen: a host gone longer than the grace
    // period stays timed out even if it comes back.
    const ended = await this.#checkEnded(session);
    if (ended) return { ok: true, ended };
    await this.store.set(`sv:hs:${sessionId}`, String(this.now()), { px: SESSION_TTL_MS });

    const events = await this.#drain(sessionId, 'host');
    let count = 0;
    for (const [viewerId, v] of await this.#viewers(sessionId)) {
      if (this.#isActive(v)) {
        count++;
      } else if (!v.left) {
        // Silent too long: count them as gone (they come back via viewerPoll).
        await this.#putViewer(sessionId, viewerId, { ...v, left: true });
        await this.logger.viewerLeave(sessionId, viewerId);
        events.push({ type: 'viewer:left', viewerId });
      }
    }
    return { ok: true, events, viewers: count, max: this.maxViewers, pollMs: this.idlePollMs };
  }

  async setQuality({ sessionId, hostToken, quality }) {
    if (!isQuality(quality) || !(await this.#verifyHost(sessionId, hostToken))) return { ok: false };
    await this.store.set(`sv:q:${sessionId}`, quality, { px: SESSION_TTL_MS });
    return { ok: true };
  }

  async hostEnd({ sessionId, hostToken, reason }) {
    if (!(await this.#verifyHost(sessionId, hostToken))) return { ok: false };
    const why = reason === 'host_stopped_sharing' ? reason : 'host_ended';
    await this.endSession(sessionId, why);
    return { ok: true };
  }

  // ---------- signaling relay ----------

  /**
   * Relay SDP descriptions / ICE candidates. The host may address any of its
   * viewers; a viewer can only ever reach its own host.
   * @param {object} p
   * @param {'host'|'viewer'} p.role
   * @param {Array<{to?: string, data: object}>} p.messages
   */
  async signal({ sessionId, role, hostToken, viewerId, viewerToken, messages }) {
    if (!Array.isArray(messages) || messages.length > 100) return { ok: false };
    let session;
    let from;
    if (role === 'host') {
      session = await this.#verifyHost(sessionId, hostToken);
      from = { role: 'host' };
    } else {
      session = await this.#verifyViewer(sessionId, viewerId, viewerToken);
      from = { role: 'viewer', viewerId };
    }
    if (!session || (await this.store.get(`sv:e:${sessionId}`))) return { ok: false };
    const viewers = role === 'host' ? await this.#viewers(sessionId) : null;
    for (const { to, data } of messages) {
      if (!data || typeof data !== 'object') continue;
      // Only SDP descriptions and ICE candidates are ever relayed.
      const clean = data.description ? { description: data.description }
        : data.candidate ? { candidate: data.candidate } : null;
      if (!clean) continue;
      if (role === 'host') {
        if (viewers.get(to) && !viewers.get(to).left) {
          await this.#send(sessionId, to, { type: 'signal', from, data: clean });
        }
      } else {
        await this.#send(sessionId, 'host', { type: 'signal', from, data: clean });
      }
    }
    return { ok: true };
  }
}
