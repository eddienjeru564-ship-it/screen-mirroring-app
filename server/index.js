// index.js — run ScreenView on your own machine: `npm start`.
//
// Serves the static frontend and the API from one Node process, so a single
// command runs everything. Sessions live in memory unless Upstash credentials
// are set (see .env.example). The same API runs on Vercel via api/index.js.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

import { createApp, configFromEnv } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const config = configFromEnv();
const app = createApp({ config });

// Static frontend, with pretty routes for the pages (/host, /view, /admin).
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

app.listen(config.port, () => {
  console.log(`ScreenView running on http://localhost:${config.port}`);
  console.log(
    `  code expiry ${config.codeExpiryMs}ms · grace ${config.graceMs}ms · ` +
    `max viewers ${app.locals.service.maxViewers} · store ${app.locals.storeKind}`
  );
  if (!config.adminPassword) console.log('  /admin is DISABLED (set ADMIN_PASSWORD to enable).');
  console.log(config.turn.url ? '  TURN configured.' : '  STUN-only (no TURN). Fine on a LAN.');
});
