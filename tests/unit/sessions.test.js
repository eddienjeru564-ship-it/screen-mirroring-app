// SessionService tests. Every test runs on each store: in-memory (local use),
// Upstash against a fake Upstash API, and Supabase against the real SQL
// function running in PGlite (both Vercel options).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService, formatCode, normaliseCode, RETAIN_ENDED_MS } from '../../server/sessions.js';
import { SessionLogger, StoreSink } from '../../server/logger.js';
import { MemoryStore } from '../../server/store.js';
import { backends } from './fakeUpstash.js';

test('normaliseCode strips separators; formatCode adds one', () => {
  assert.equal(normaliseCode('482-913'), '482913');
  assert.equal(normaliseCode(' 482 913 '), '482913');
  assert.equal(normaliseCode(null), '');
  assert.equal(formatCode('482913'), '482-913');
});

function setup(make, opts = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = make(clock.now);
  const logStore = new MemoryStore({ now: clock.now });
  const logger = new SessionLogger(new StoreSink(logStore));
  const svc = new SessionService({
    store, logger, now: clock.now,
    codeExpiryMs: 10 * 60_000, graceMs: 60_000, viewerStaleMs: 12_000, maxViewers: 1,
    ...opts,
  });
  return { svc, clock, logger };
}

const hostAuth = (s) => ({ sessionId: s.sessionId, hostToken: s.hostToken });
const viewerAuth = (j) => ({ sessionId: j.sessionId, viewerId: j.viewerId, viewerToken: j.viewerToken });

for (const [name, make] of backends()) {
  test(`${name}: codes are 6 digits, unique while live, never sequential`, async () => {
    const { svc } = setup(make);
    const codes = [];
    for (let i = 0; i < 60; i++) codes.push((await svc.createSession()).code);
    for (const c of codes) assert.match(c, /^\d{6}$/);
    assert.equal(new Set(codes).size, codes.length);
    const sequential = codes.slice(1).filter((c, i) => Number(c) === Number(codes[i]) + 1).length;
    assert.ok(sequential < 3);
  });

  test(`${name}: viewer joins with the code; host is told and counts 1`, async () => {
    const { svc } = setup(make);
    const s = await svc.createSession({ quality: 'high' });
    const j = await svc.joinByCode(formatCode(s.code));
    assert.equal(j.ok, true);
    const poll = await svc.hostPoll(hostAuth(s));
    assert.equal(poll.viewers, 1);
    assert.deepEqual(poll.events, [{ type: 'viewer:joined', viewerId: j.viewerId }]);
    assert.equal((await svc.viewerPoll(viewerAuth(j))).quality, 'high');
  });

  test(`${name}: wrong codes, wrong passwords and tokens are refused`, async () => {
    const { svc } = setup(make);
    assert.equal((await svc.joinByCode('000000')).error, 'invalid_code');
    assert.equal((await svc.joinByCode('12')).error, 'invalid_code');
    const s = await svc.createSession({ password: 'secret' });
    assert.equal((await svc.joinByCode(s.code)).error, 'wrong_password');
    assert.equal((await svc.joinByCode(s.code, 'nope')).error, 'wrong_password');
    assert.equal((await svc.joinByCode(s.code, 'secret')).ok, true);
    assert.equal((await svc.hostPoll({ sessionId: s.sessionId, hostToken: 'forged' })).error, 'not_found');
    assert.equal((await svc.viewerPoll({ sessionId: s.sessionId, viewerId: 'x', viewerToken: 'y' })).error, 'not_found');
  });

  test(`${name}: session full at MAX_VIEWERS; a gone viewer frees the seat`, async () => {
    const { svc, clock } = setup(make, { maxViewers: 2 });
    const s = await svc.createSession();
    const a = await svc.joinByCode(s.code);
    assert.equal((await svc.joinByCode(s.code)).ok, true);
    assert.equal((await svc.joinByCode(s.code)).error, 'session_full');
    await svc.viewerLeave(viewerAuth(a));
    assert.equal((await svc.joinByCode(s.code)).ok, true);
    // Viewers that stop polling for longer than viewerStaleMs also free their seat.
    clock.advance(13_000);
    await svc.hostPoll(hostAuth(s));
    assert.equal((await svc.joinByCode(s.code)).ok, true);
  });

  test(`${name}: max viewers is clamped to 1..3`, () => {
    assert.equal(setup(make, { maxViewers: 9 }).svc.maxViewers, 3);
    assert.equal(setup(make, { maxViewers: 0 }).svc.maxViewers, 1);
  });

  test(`${name}: unused code expires; a used one does not`, async () => {
    const { svc, clock } = setup(make);
    const unused = await svc.createSession();
    const used = await svc.createSession();
    await svc.joinByCode(used.code);
    clock.advance(10 * 60_000);
    await svc.hostPoll(hostAuth(used)); // keep the host alive
    assert.equal((await svc.joinByCode(unused.code)).error, 'expired');
    assert.equal((await svc.hostPoll(hostAuth(unused))).ended, 'expired');
    assert.notEqual((await svc.hostPoll(hostAuth(used))).ended, 'expired');
  });

  test(`${name}: ended code is dead forever (accurate error for an hour)`, async () => {
    const { svc, clock } = setup(make);
    const s = await svc.createSession();
    const j = await svc.joinByCode(s.code);
    assert.deepEqual(await svc.hostEnd({ ...hostAuth(s), reason: 'host_ended' }), { ok: true });
    assert.equal((await svc.viewerPoll(viewerAuth(j))).ended, 'host_ended');
    assert.equal((await svc.joinByCode(s.code)).error, 'ended');
    clock.advance(RETAIN_ENDED_MS);
    assert.equal((await svc.joinByCode(s.code)).error, 'invalid_code');
  });

  test(`${name}: only the first ending counts`, async () => {
    const { svc } = setup(make);
    const s = await svc.createSession();
    assert.equal(await svc.endSession(s.sessionId, 'host_stopped_sharing'), true);
    assert.equal(await svc.endSession(s.sessionId, 'host_ended'), false);
    assert.equal((await svc.hostPoll(hostAuth(s))).ended, 'host_stopped_sharing');
  });

  test(`${name}: host silent past the grace period ends the session`, async () => {
    const { svc, clock } = setup(make);
    const s = await svc.createSession();
    const j = await svc.joinByCode(s.code);
    clock.advance(30_000);
    await svc.viewerPoll(viewerAuth(j));
    assert.equal((await svc.hostPoll(hostAuth(s))).ok, true); // back within grace
    clock.advance(61_000);
    await svc.viewerPoll(viewerAuth(j)); // viewer keeps polling, host does not
    assert.equal((await svc.viewerPoll(viewerAuth(j))).ended, 'host_timeout');
    // Coming back too late does not revive it.
    assert.equal((await svc.hostPoll(hostAuth(s))).ended, 'host_timeout');
  });

  test(`${name}: a viewer away too long rejoins without the code; host re-offers`, async () => {
    const { svc, clock } = setup(make);
    const s = await svc.createSession();
    const j = await svc.joinByCode(s.code);
    await svc.hostPoll(hostAuth(s));
    clock.advance(13_000);
    const p1 = await svc.hostPoll(hostAuth(s));
    assert.deepEqual(p1.events, [{ type: 'viewer:left', viewerId: j.viewerId }]);
    assert.equal(p1.viewers, 0);
    const back = await svc.viewerPoll(viewerAuth(j));
    assert.equal(back.rejoined, true);
    const p2 = await svc.hostPoll(hostAuth(s));
    assert.deepEqual(p2.events, [{ type: 'viewer:joined', viewerId: j.viewerId, rejoin: true }]);
    assert.equal(p2.viewers, 1);
  });

  test(`${name}: a viewer who pressed Leave cannot come back with the old token`, async () => {
    const { svc } = setup(make);
    const s = await svc.createSession();
    const j = await svc.joinByCode(s.code);
    await svc.viewerLeave(viewerAuth(j));
    assert.equal((await svc.viewerPoll(viewerAuth(j))).ended, 'left');
    assert.deepEqual((await svc.hostPoll(hostAuth(s))).events.at(-1), { type: 'viewer:left', viewerId: j.viewerId });
  });

  test(`${name}: signaling relays only SDP/ICE, only within the session`, async () => {
    const { svc } = setup(make, { maxViewers: 2 });
    const s = await svc.createSession();
    const a = await svc.joinByCode(s.code);
    const b = await svc.joinByCode(s.code);
    const other = await svc.createSession();
    await svc.hostPoll(hostAuth(s)); // clear join notices

    await svc.signal({ role: 'host', ...hostAuth(s), messages: [
      { to: a.viewerId, data: { description: { type: 'offer', sdp: 'X' }, evil: 1 } },
      { to: a.viewerId, data: { keypress: 'A' } }, // not SDP/ICE: dropped
      { to: 'not-a-viewer', data: { candidate: { candidate: 'c' } } },
    ] });
    const pa = await svc.viewerPoll(viewerAuth(a));
    assert.deepEqual(pa.events, [{ type: 'signal', from: { role: 'host' }, data: { description: { type: 'offer', sdp: 'X' } } }]);
    assert.deepEqual((await svc.viewerPoll(viewerAuth(b))).events, []);

    // A viewer's message always goes to its own host, never to another viewer.
    await svc.signal({ role: 'viewer', ...viewerAuth(b), messages: [{ to: a.viewerId, data: { candidate: { candidate: 'c' } } }] });
    assert.deepEqual((await svc.viewerPoll(viewerAuth(a))).events, []);
    const hp = await svc.hostPoll(hostAuth(s));
    assert.deepEqual(hp.events, [{ type: 'signal', from: { role: 'viewer', viewerId: b.viewerId }, data: { candidate: { candidate: 'c' } } }]);
    assert.deepEqual((await svc.hostPoll(hostAuth(other))).events, []);

    // Forged credentials relay nothing.
    assert.equal((await svc.signal({ role: 'host', sessionId: s.sessionId, hostToken: 'x', messages: [] })).ok, false);
  });

  test(`${name}: the log has start, join, leave and end with a duration`, async () => {
    const { svc, clock, logger } = setup(make);
    const s = await svc.createSession({ password: 'pw' });
    await svc.joinByCode(s.code, 'pw');
    clock.advance(65_000);
    await svc.hostEnd({ ...hostAuth(s) });
    const [row] = await logger.readSessions();
    assert.equal(row.code, s.code);
    assert.equal(row.hasPassword, true);
    assert.equal(row.viewerJoins, 1);
    assert.equal(row.viewerLeaves, 1); // closed out when the session ended
    assert.equal(row.endReason, 'host_ended');
    assert.equal(row.durationHuman, '1m 5s');
  });
}
