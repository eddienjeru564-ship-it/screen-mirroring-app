// sessions.js — in-memory session & join-code manager.
//
// Pure logic with no Express/Socket.io dependencies so it can be unit-tested in
// isolation. A "session" is one host sharing their screen; viewers attach to it
// by its 6-digit code. Time is injected (`now()`) so tests can control expiry.

import { randomInt, randomUUID } from 'node:crypto';

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

export class SessionManager {
  /**
   * @param {object} opts
   * @param {number} opts.codeExpiryMs  unused-code lifetime
   * @param {number} opts.graceMs       host-disconnect grace period
   * @param {number} opts.maxViewers    viewers allowed per session
   * @param {() => number} [opts.now]   clock (defaults to Date.now)
   */
  constructor({ codeExpiryMs, graceMs, maxViewers, now = Date.now } = {}) {
    this.codeExpiryMs = codeExpiryMs ?? 10 * 60 * 1000;
    this.graceMs = graceMs ?? 60 * 1000;
    this.maxViewers = Math.min(Math.max(maxViewers ?? 3, 1), 3);
    this.now = now;

    /** @type {Map<string, object>} code -> session (only while code is live) */
    this.byCode = new Map();
    /** @type {Map<string, object>} sessionId -> session (always, until purged) */
    this.byId = new Map();
  }

  /** Create a session for a host. Returns the session object. */
  createSession({ password = null, quality = 'medium' } = {}) {
    let code = rawCode();
    while (this.byCode.has(code)) code = rawCode(); // avoid active-code collisions

    const t = this.now();
    const session = {
      sessionId: randomUUID(),
      code,
      hostToken: randomUUID(),
      password: password || null,
      quality,
      status: 'waiting', // waiting -> live -> ended
      createdAt: t,
      startedAt: t,
      endedAt: null,
      endReason: null,
      expiresAt: t + this.codeExpiryMs, // only meaningful while 'waiting'
      hostConnected: true,
      graceUntil: null,
      viewers: new Map(), // viewerId -> { viewerToken, joinedAt, leftAt, connected }
    };
    this.byCode.set(code, session);
    this.byId.set(session.sessionId, session);
    return session;
  }

  /** Has an unused code passed its expiry? (ended sessions are never 'waiting') */
  isExpired(session) {
    return session.status === 'waiting' && this.now() >= session.expiresAt;
  }

  /**
   * Attempt to add a viewer by code (+ optional password).
   * Returns { ok, session?, viewerId?, viewerToken?, error? }.
   * error ∈ 'invalid_code' | 'expired' | 'wrong_password' | 'session_full' | 'ended'
   */
  joinByCode(codeInput, password = null) {
    const code = normaliseCode(codeInput);
    const session = this.byCode.get(code);
    if (!session) return { ok: false, error: 'invalid_code' };
    if (session.status === 'ended') return { ok: false, error: 'ended' };
    if (this.isExpired(session)) {
      this.endSession(session.sessionId, 'expired');
      return { ok: false, error: 'expired' };
    }
    if (session.password && session.password !== password) {
      return { ok: false, error: 'wrong_password' };
    }
    if (this.activeViewerCount(session) >= this.maxViewers) {
      return { ok: false, error: 'session_full' };
    }

    const viewerId = randomUUID();
    const viewerToken = randomUUID();
    session.viewers.set(viewerId, {
      viewerToken,
      joinedAt: this.now(),
      leftAt: null,
      connected: true,
    });
    // First viewer flips the session live and freezes the expiry clock.
    if (session.status === 'waiting') session.status = 'live';
    return { ok: true, session, viewerId, viewerToken };
  }

  activeViewerCount(session) {
    let n = 0;
    for (const v of session.viewers.values()) if (v.connected) n++;
    return n;
  }

  getById(sessionId) {
    return this.byId.get(sessionId) || null;
  }

  /** Validate a host rejoin token. */
  verifyHost(sessionId, hostToken) {
    const s = this.byId.get(sessionId);
    if (!s || s.status === 'ended') return null;
    return s.hostToken === hostToken ? s : null;
  }

  /** Validate a viewer rejoin token. */
  verifyViewer(sessionId, viewerId, viewerToken) {
    const s = this.byId.get(sessionId);
    if (!s || s.status === 'ended') return null;
    const v = s.viewers.get(viewerId);
    if (!v || v.viewerToken !== viewerToken) return null;
    return s;
  }

  markViewerLeft(sessionId, viewerId) {
    const s = this.byId.get(sessionId);
    const v = s?.viewers.get(viewerId);
    if (v && v.connected) {
      v.connected = false;
      v.leftAt = this.now();
      return s;
    }
    return null;
  }

  /** End a session for good. The code is removed and can never be reused. */
  endSession(sessionId, reason = 'host_ended') {
    const s = this.byId.get(sessionId);
    if (!s || s.status === 'ended') return null;
    s.status = 'ended';
    s.endedAt = this.now();
    s.endReason = reason;
    s.graceUntil = null;
    this.byCode.delete(s.code); // code is dead forever
    return s;
  }

  /** Sweep expired unused codes and grace-expired sessions. Returns ended ones. */
  sweep() {
    const ended = [];
    const t = this.now();
    for (const s of this.byId.values()) {
      if (s.status === 'ended') continue;
      if (this.isExpired(s)) {
        ended.push(this.endSession(s.sessionId, 'expired'));
      } else if (s.graceUntil != null && t >= s.graceUntil) {
        ended.push(this.endSession(s.sessionId, 'host_timeout'));
      }
    }
    return ended.filter(Boolean);
  }
}
