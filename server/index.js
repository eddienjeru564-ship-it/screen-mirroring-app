// index.js — Express + Socket.io bootstrap.
//
// Serves the static frontend AND runs the signaling server, so a single
// `npm start` runs everything. Signaling is a thin relay: the server never
// touches media, only brokers SDP/ICE between host and viewers and tracks
// session lifecycle.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { SessionManager, formatCode, normaliseCode } from './sessions.js';
import { RateLimiter } from './rateLimit.js';
import { SessionLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const LOG_FILE = process.env.LOG_FILE || join(__dirname, '..', 'logs', 'sessions.jsonl');

// ---- Config (env-driven, LAN-friendly defaults) ----------------------------
const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const PORT = num(process.env.PORT, 3000);
const CODE_EXPIRY_MS = num(process.env.CODE_EXPIRY_MS, 10 * 60 * 1000);
const GRACE_MS = num(process.env.GRACE_MS, 60 * 1000);
const MAX_VIEWERS = num(process.env.MAX_VIEWERS, 1);
const RATE_LIMIT_MAX = num(process.env.RATE_LIMIT_MAX, 5);
const RATE_LIMIT_WINDOW_MS = num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;

// ---- Shared state -----------------------------------------------------------
const sessions = new SessionManager({
  codeExpiryMs: CODE_EXPIRY_MS,
  graceMs: GRACE_MS,
  maxViewers: MAX_VIEWERS,
});
const limiter = new RateLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
const logger = new SessionLogger(LOG_FILE);

/** Build the ICE server list from env. STUN always; TURN only if configured. */
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (TURN_URL) {
    list.push({ urls: TURN_URL, username: TURN_USERNAME || '', credential: TURN_CREDENTIAL || '' });
  }
  return list;
}

// ---- HTTP app ---------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // so req.ip reflects X-Forwarded-For behind a proxy
app.use(express.json());

// ICE configuration for clients (keeps TURN creds out of static files).
app.get('/api/ice-config', (_req, res) => {
  res.json({ iceServers: iceServers(), maxViewers: sessions.maxViewers });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Admin API: list sessions, guarded by ADMIN_PASSWORD (sent as a header).
app.get('/api/admin/sessions', async (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'admin_disabled' });
  }
  const supplied = req.get('x-admin-password') || '';
  if (supplied !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const all = await logger.readSessions();
  res.json({ sessions: all.slice(0, 200) });
});

// Static frontend. Pretty routes for the page files.
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
for (const [route, file] of [
  ['/', 'index.html'],
  ['/host', 'host.html'],
  ['/view', 'view.html'],
  ['/admin', 'admin.html'],
]) {
  app.get(route, (_req, res) => res.sendFile(join(PUBLIC_DIR, file)));
}

// ---- Socket.io signaling ----------------------------------------------------
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  // Generous timeouts so brief blips don't drop the socket; the client also
  // auto-reconnects and rejoins.
  pingInterval: 20_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1e6,
});

// Per-socket context: what session/role this socket currently is.
/** @type {Map<string, {sessionId:string, role:'host'|'viewer', viewerId?:string}>} */
const socketCtx = new Map();

function roomFor(sessionId) {
  return `session:${sessionId}`;
}

/** Notify the host of the current live viewer count. */
function pushViewerCount(session) {
  io.to(roomFor(session.sessionId)).emit('session:viewers', {
    count: sessions.activeViewerCount(session),
    max: sessions.maxViewers,
  });
}

/** End a session and tell everyone. */
function teardown(session, reason) {
  if (!session || session.status === 'ended') return;
  sessions.endSession(session.sessionId, reason);
  announceEnded(session);
}

/** Log the end of an already-ended session (closing out viewers) and notify the room. */
function announceEnded(session) {
  for (const [viewerId, v] of session.viewers) {
    if (v.connected && sessions.markViewerLeft(session.sessionId, viewerId)) {
      logger.viewerLeave(session.sessionId, viewerId);
    }
  }
  logger.sessionEnd(session);
  io.to(roomFor(session.sessionId)).emit('session:ended', { reason: session.endReason });
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address || 'unknown';

  // --- Host starts a session ---
  socket.on('host:create', (payload = {}, cb) => {
    const quality = ['low', 'medium', 'high'].includes(payload.quality) ? payload.quality : 'medium';
    const password = typeof payload.password === 'string' && payload.password.trim()
      ? payload.password.trim()
      : null;
    const session = sessions.createSession({ password, quality });
    socket.join(roomFor(session.sessionId));
    socketCtx.set(socket.id, { sessionId: session.sessionId, role: 'host' });
    session.hostSocketId = socket.id;
    logger.sessionStart(session);
    respond(cb, {
      ok: true,
      sessionId: session.sessionId,
      code: session.code,
      codePretty: formatCode(session.code),
      hostToken: session.hostToken,
      quality: session.quality,
      hasPassword: !!session.password,
      expiresInMs: session.expiresAt - Date.now(),
    });
  });

  // --- Host reconnects to an existing session (socket id changed) ---
  socket.on('host:rejoin', ({ sessionId, hostToken } = {}, cb) => {
    const session = sessions.verifyHost(sessionId, hostToken);
    if (!session) return respond(cb, { ok: false, error: 'not_found' });
    socket.join(roomFor(session.sessionId));
    socketCtx.set(socket.id, { sessionId: session.sessionId, role: 'host' });
    session.hostSocketId = socket.id;
    session.graceUntil = null; // host is back; cancel teardown
    // Hand back the live viewers so the host can re-offer to each.
    const viewers = [...session.viewers.entries()]
      .filter(([, v]) => v.connected)
      .map(([viewerId]) => viewerId);
    respond(cb, { ok: true, viewers, quality: session.quality });
    pushViewerCount(session);
  });

  // --- Viewer joins by code ---
  socket.on('viewer:join', ({ code, password } = {}, cb) => {
    if (limiter.isLimited(ip)) {
      return respond(cb, {
        ok: false,
        error: 'rate_limited',
        retryAfterMs: limiter.retryAfterMs(ip),
      });
    }
    const result = sessions.joinByCode(normaliseCode(code), password ?? null);
    if (!result.ok) {
      // Only count attempts that are genuinely wrong codes/passwords.
      if (['invalid_code', 'wrong_password', 'expired', 'ended'].includes(result.error)) {
        limiter.recordFailure(ip);
      }
      return respond(cb, { ok: false, error: result.error });
    }
    limiter.reset(ip);
    const { session, viewerId, viewerToken } = result;
    socket.join(roomFor(session.sessionId));
    socketCtx.set(socket.id, { sessionId: session.sessionId, role: 'viewer', viewerId });
    session.viewers.get(viewerId).socketId = socket.id;
    logger.viewerJoin(session.sessionId, viewerId);

    respond(cb, { ok: true, sessionId: session.sessionId, viewerId, viewerToken });
    // Tell the host to open a peer connection and offer to this viewer.
    if (session.hostSocketId) {
      io.to(session.hostSocketId).emit('viewer:joined', { viewerId });
    }
    pushViewerCount(session);
  });

  // --- Viewer reconnects ---
  socket.on('viewer:rejoin', ({ sessionId, viewerId, viewerToken } = {}, cb) => {
    const session = sessions.verifyViewer(sessionId, viewerId, viewerToken);
    if (!session) return respond(cb, { ok: false, error: 'not_found' });
    const v = session.viewers.get(viewerId);
    v.connected = true;
    v.leftAt = null;
    v.socketId = socket.id;
    socket.join(roomFor(session.sessionId));
    socketCtx.set(socket.id, { sessionId: session.sessionId, role: 'viewer', viewerId });
    respond(cb, { ok: true, quality: session.quality });
    // Ask the host to re-offer to this viewer.
    if (session.hostSocketId) {
      io.to(session.hostSocketId).emit('viewer:joined', { viewerId });
    }
    pushViewerCount(session);
  });

  // --- Signaling relay (SDP offers/answers and ICE candidates) ---
  // Addressed within a session: host <-> a specific viewerId.
  socket.on('signal', ({ to, data } = {}) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    const session = sessions.getById(ctx.sessionId);
    if (!session || session.status === 'ended') return;

    let targetSocketId = null;
    let from;
    if (ctx.role === 'host') {
      // Host -> viewer `to`
      const v = session.viewers.get(to);
      targetSocketId = v?.connected ? v.socketId : null;
      from = { role: 'host' };
    } else {
      // Viewer -> host (ignores `to`; viewers only ever talk to the host)
      targetSocketId = session.hostSocketId;
      from = { role: 'viewer', viewerId: ctx.viewerId };
    }
    if (targetSocketId) io.to(targetSocketId).emit('signal', { from, data });
  });

  // --- Host changes quality; relay so viewers could react if needed ---
  socket.on('host:quality', ({ quality } = {}) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || ctx.role !== 'host') return;
    const session = sessions.getById(ctx.sessionId);
    if (!session) return;
    if (['low', 'medium', 'high'].includes(quality)) {
      session.quality = quality;
      io.to(roomFor(session.sessionId)).emit('session:quality', { quality });
    }
  });

  // --- Host ends the session on purpose ---
  socket.on('host:end', (_payload, cb) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || ctx.role !== 'host') return respond(cb, { ok: false });
    const session = sessions.getById(ctx.sessionId);
    teardown(session, 'host_ended');
    respond(cb, { ok: true });
  });

  // --- Disconnect handling with grace period ---
  socket.on('disconnect', () => {
    const ctx = socketCtx.get(socket.id);
    socketCtx.delete(socket.id);
    if (!ctx) return;
    const session = sessions.getById(ctx.sessionId);
    if (!session || session.status === 'ended') return;

    if (ctx.role === 'host') {
      // Keep the session alive for GRACE_MS so the host can reconnect.
      session.graceUntil = Date.now() + sessions.graceMs;
    } else {
      sessions.markViewerLeft(session.sessionId, ctx.viewerId);
      logger.viewerLeave(session.sessionId, ctx.viewerId);
      // Tell the host a viewer dropped (it may reconnect within the session).
      if (session.hostSocketId) {
        io.to(session.hostSocketId).emit('viewer:left', { viewerId: ctx.viewerId });
      }
      pushViewerCount(session);
    }
  });
});

function respond(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

// ---- Periodic sweep: expire unused codes, tear down grace-expired hosts ----
const sweepTimer = setInterval(() => {
  for (const ended of sessions.sweep()) announceEnded(ended);
}, 5_000);
sweepTimer.unref?.();

// ---- Start ------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`ScreenView running on http://localhost:${PORT}`);
  console.log(
    `  code expiry ${CODE_EXPIRY_MS}ms · grace ${GRACE_MS}ms · max viewers ${sessions.maxViewers}`
  );
  if (!ADMIN_PASSWORD) console.log('  /admin is DISABLED (set ADMIN_PASSWORD to enable).');
  if (TURN_URL) console.log('  TURN configured.');
  else console.log('  STUN-only (no TURN). Fine on a LAN.');
});
