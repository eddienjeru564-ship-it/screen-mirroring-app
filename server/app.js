// app.js — the HTTP API, shared by the local server (server/index.js) and the
// Vercel function (api/index.js).
//
// Signaling is plain HTTPS: the browsers POST their messages and poll for
// replies every ~2 s (faster while connecting). Every request is independent
// and all state lives in the store, so it runs the same on one laptop or on
// many serverless instances. Video never touches the server; it flows
// browser-to-browser over WebRTC.

import { networkInterfaces } from 'node:os';
import express from 'express';

import { SessionService } from './sessions.js';
import { RateLimiter } from './rateLimit.js';
import { SessionLogger, FileSink, StoreSink } from './logger.js';
import { storeFromEnv } from './store.js';

const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Read all settings from environment variables (with LAN-friendly defaults). */
export function configFromEnv(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    codeExpiryMs: num(env.CODE_EXPIRY_MS, 10 * 60 * 1000),
    graceMs: num(env.GRACE_MS, 60 * 1000),
    viewerStaleMs: num(env.VIEWER_STALE_MS, 12 * 1000),
    maxViewers: num(env.MAX_VIEWERS, 1),
    rateLimitMax: num(env.RATE_LIMIT_MAX, 5),
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    adminPassword: env.ADMIN_PASSWORD || '',
    turn: { url: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
    logFile: env.LOG_FILE || 'logs/sessions.jsonl',
    onVercel: !!env.VERCEL,
  };
}

/**
 * Build the Express app.
 * @param {object} [opts]
 * @param {object} [opts.config]  from configFromEnv()
 * @param {object} [opts.store]   overrides the store picked from the environment
 */
export function createApp({ config = configFromEnv(), store: givenStore } = {}) {
  const picked = givenStore ? { store: givenStore, kind: 'custom' } : storeFromEnv();
  const { store, kind: storeKind } = picked;
  // On Vercel every request may hit a different instance, so in-memory state
  // would silently break sessions. Refuse clearly instead.
  const storageMissing = config.onVercel && storeKind === 'memory';

  const logger = new SessionLogger(
    config.onVercel ? new StoreSink(store) : new FileSink(config.logFile)
  );
  const service = new SessionService({
    store,
    logger,
    codeExpiryMs: config.codeExpiryMs,
    graceMs: config.graceMs,
    viewerStaleMs: config.viewerStaleMs,
    maxViewers: config.maxViewers,
  });
  const limiter = new RateLimiter({
    store,
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // req.ip from X-Forwarded-For (set by Vercel / proxies)
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Wrap async handlers so a store failure becomes a clean JSON 500. */
  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}, req));
    } catch (err) {
      console.error('[api]', req.path, err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
    }
  };

  // Everything that touches sessions needs real storage on Vercel.
  app.use('/api', (req, res, next) => {
    if (storageMissing && !['/health', '/ice-config', '/info'].includes(req.path)) {
      return res.status(503).json({ ok: false, error: 'storage_not_configured' });
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, store: storeKind, storageConfigured: !storageMissing });
  });

  // ICE configuration for clients (keeps TURN credentials out of static files).
  app.get('/api/ice-config', (_req, res) => {
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const { url, username, credential } = config.turn;
    if (url) iceServers.push({ urls: url, username: username || '', credential: credential || '' });
    res.json({ iceServers, maxViewers: service.maxViewers });
  });

  // This machine's LAN addresses, so a host on localhost can hand out a link
  // that works from another computer. Meaningless (and hidden) on Vercel.
  app.get('/api/info', (_req, res) => {
    const lanUrls = [];
    if (!config.onVercel) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) lanUrls.push(`http://${a.address}:${config.port}`);
        }
      }
    }
    res.json({ lanUrls });
  });

  // ---- Host ----
  app.post('/api/host/create', route(async (b) => {
    const password = typeof b.password === 'string' && b.password.trim() ? b.password.trim() : null;
    return { ok: true, ...(await service.createSession({ password, quality: b.quality })) };
  }));
  app.post('/api/host/poll', route((b) => service.hostPoll(b)));
  app.post('/api/host/quality', route((b) => service.setQuality(b)));
  app.post('/api/host/end', route((b) => service.hostEnd(b)));

  // ---- Viewer ----
  app.post('/api/viewer/join', route(async (b, req) => {
    const ip = req.ip || 'unknown';
    if (await limiter.isLimited(ip)) {
      return { ok: false, error: 'rate_limited', retryAfterMs: await limiter.retryAfterMs(ip) };
    }
    const password = typeof b.password === 'string' ? b.password : null;
    const result = await service.joinByCode(b.code, password);
    if (!result.ok) {
      // Count only genuinely wrong guesses (not "full" or "busy").
      if (['invalid_code', 'wrong_password', 'expired', 'ended'].includes(result.error)) {
        await limiter.recordFailure(ip);
      }
      return result;
    }
    await limiter.reset(ip);
    return result;
  }));
  app.post('/api/viewer/poll', route((b) => service.viewerPoll(b)));
  // navigator.sendBeacon posts text/plain, so parse that too.
  app.post('/api/viewer/leave', express.text(), route((b) =>
    service.viewerLeave(typeof b === 'string' ? safeJson(b) : b)));

  // ---- Signaling relay (both roles) ----
  app.post('/api/signal', route((b) => service.signal(b)));

  // ---- Admin: list sessions, guarded by ADMIN_PASSWORD (sent as a header) ----
  app.get('/api/admin/sessions', async (req, res) => {
    if (!config.adminPassword) return res.status(503).json({ error: 'admin_disabled' });
    if ((req.get('x-admin-password') || '') !== config.adminPassword) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const all = await logger.readSessions();
      res.json({ sessions: all.slice(0, 200) });
    } catch (err) {
      console.error('[admin]', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  app.locals.service = service;
  app.locals.storeKind = storeKind;
  return app;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
