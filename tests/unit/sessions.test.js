import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, formatCode, normaliseCode, RETAIN_ENDED_MS } from '../../server/sessions.js';

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('codes are 6 digits and format as NNN-NNN', () => {
  const m = new SessionManager({});
  for (let i = 0; i < 200; i++) {
    const s = m.createSession();
    assert.match(s.code, /^\d{6}$/);
    assert.match(formatCode(s.code), /^\d{3}-\d{3}$/);
  }
});

test('codes are unique among active sessions', () => {
  const m = new SessionManager({});
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const s = m.createSession();
    assert.ok(!seen.has(s.code), 'duplicate active code');
    seen.add(s.code);
  }
});

test('normaliseCode strips separators', () => {
  assert.equal(normaliseCode('482-913'), '482913');
  assert.equal(normaliseCode(' 482 913 '), '482913');
  assert.equal(normaliseCode(null), '');
});

test('viewer can join with a valid code (dashes allowed)', () => {
  const m = new SessionManager({});
  const s = m.createSession();
  const r = m.joinByCode(formatCode(s.code));
  assert.equal(r.ok, true);
  assert.ok(r.viewerId && r.viewerToken);
  assert.equal(s.status, 'live');
});

test('invalid code is rejected', () => {
  const m = new SessionManager({});
  m.createSession();
  assert.deepEqual(m.joinByCode('abc'), { ok: false, error: 'invalid_code' });
});

test('unused code expires after codeExpiryMs', () => {
  const clock = makeClock();
  const m = new SessionManager({ codeExpiryMs: 1000, now: clock.now });
  const s = m.createSession();
  clock.advance(1001);
  assert.equal(m.joinByCode(s.code).error, 'expired');
  // ...and is dead forever afterwards (still reported as expired, never joinable).
  assert.equal(m.joinByCode(s.code).error, 'expired');
});

test('a live session does not expire once a viewer has joined', () => {
  const clock = makeClock();
  const m = new SessionManager({ codeExpiryMs: 1000, maxViewers: 2, now: clock.now });
  const s = m.createSession();
  assert.ok(m.joinByCode(s.code).ok);
  clock.advance(10_000);
  assert.equal(m.sweep().length, 0);
  assert.ok(m.joinByCode(s.code).ok, 'second viewer can still join a live session');
});

test('sweep ends expired unused sessions', () => {
  const clock = makeClock();
  const m = new SessionManager({ codeExpiryMs: 1000, now: clock.now });
  const s = m.createSession();
  clock.advance(2000);
  const ended = m.sweep();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].endReason, 'expired');
  // Swept before anyone tried it: the viewer still gets an accurate error.
  assert.equal(m.joinByCode(s.code).error, 'expired');
});

test('session full when maxViewers reached; slot frees on leave', () => {
  const m = new SessionManager({ maxViewers: 1 });
  const s = m.createSession();
  const a = m.joinByCode(s.code);
  assert.ok(a.ok);
  assert.equal(m.joinByCode(s.code).error, 'session_full');
  m.markViewerLeft(s.sessionId, a.viewerId);
  assert.ok(m.joinByCode(s.code).ok);
});

test('maxViewers is clamped to 1..3', () => {
  assert.equal(new SessionManager({ maxViewers: 10 }).maxViewers, 3);
  assert.equal(new SessionManager({ maxViewers: 0 }).maxViewers, 1);
});

test('ended session code is dead forever', () => {
  const m = new SessionManager({});
  const s = m.createSession();
  m.endSession(s.sessionId, 'host_ended');
  assert.equal(m.joinByCode(s.code).error, 'ended');
  assert.equal(m.verifyHost(s.sessionId, s.hostToken), null);
});

test('password required when set', () => {
  const m = new SessionManager({});
  const s = m.createSession({ password: 'pw' });
  assert.equal(m.joinByCode(s.code).error, 'wrong_password');
  assert.equal(m.joinByCode(s.code, 'nope').error, 'wrong_password');
  assert.ok(m.joinByCode(s.code, 'pw').ok);
});

test('rejoin tokens are verified', () => {
  const m = new SessionManager({});
  const s = m.createSession();
  const v = m.joinByCode(s.code);
  assert.equal(m.verifyHost(s.sessionId, s.hostToken), s);
  assert.equal(m.verifyHost(s.sessionId, 'bad'), null);
  assert.equal(m.verifyViewer(s.sessionId, v.viewerId, v.viewerToken), s);
  assert.equal(m.verifyViewer(s.sessionId, v.viewerId, 'bad'), null);
});

test('host grace period ends session with host_timeout', () => {
  const clock = makeClock();
  const m = new SessionManager({ graceMs: 500, now: clock.now });
  const s = m.createSession();
  m.joinByCode(s.code);
  s.graceUntil = clock.now() + m.graceMs;
  clock.advance(400);
  assert.equal(m.sweep().length, 0);
  clock.advance(200);
  const ended = m.sweep();
  assert.equal(ended[0].endReason, 'host_timeout');
});

test('ended sessions and dead codes are purged after the retention window', () => {
  const clock = makeClock();
  const m = new SessionManager({ now: clock.now });
  const s = m.createSession();
  m.endSession(s.sessionId, 'host_ended');
  clock.advance(RETAIN_ENDED_MS);
  m.sweep();
  assert.equal(m.getById(s.sessionId), null);
  assert.equal(m.joinByCode(s.code).error, 'invalid_code');
});
