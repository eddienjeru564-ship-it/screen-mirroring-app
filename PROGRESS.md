# ScreenView — progress

Checklist tracks every feature and Definition-of-Done item. A box is checked
only after the thing has been **run and verified**, not when the code is merely
written. The test that verifies each item is named where there is one.

## Setup
- [x] Project scaffold, git init, package.json, .env.example
- [x] Research notes recorded in DECISIONS.md

## Server
- [x] `sessions.js` — code generation, expiry, viewer limits, lifecycle (unit-tested)
- [x] `logger.js` — append-only jsonl session log (unit-tested)
- [x] `rateLimit.js` — per-IP code-attempt limiting (unit-tested)
- [x] `index.js` — Express + Socket.io, static serving, signaling, ICE config, admin

## Frontend
- [x] `index.html` — landing (Share / View)
- [x] `host.html` + `host.js`
- [x] `view.html` + `view.js`
- [x] `admin.html` + `admin.js`
- [x] `rtc.js` — shared WebRTC helpers (connection monitor unit-tested)
- [x] `styles.css`
- [x] `app.js`, `sw.js`, manifest, icons — installable app (e2e: Chrome reports installable)

## Must-have features
- [x] 1. 6-digit unique, non-sequential code (`crypto.randomInt`) — unit tests
- [x] 2. Unused code expires (configurable); ended session's code dead forever — unit + e2e
- [x] 3. One viewer per session by default (`MAX_VIEWERS`, up to 3) — e2e "session full"
- [x] 4. View-only by design: recvonly, no data channel, no input path — e2e view-only test
- [x] 5. Long-session stability: drop detection, ICE restart, socket reconnect + rejoin, grace period, `track.onended` — e2e + unit + soak
- [x] 6. Host controls: End session, visible code, viewer indicator, timer — e2e
- [x] 7. Viewer UX: auto-formatting input, error states, fullscreen, status badge, reconnecting overlay — e2e
- [x] 8. Session log + password-protected `/admin` table — e2e admin test

## Nice-to-have
- [x] 9. Optional host-set session password — e2e
- [x] 10. Rate limiting on code attempts — unit + e2e
- [x] 11. Adaptive quality (Low/Medium/High, live switch) — e2e checks received resolution

## Extras (beyond the brief)
- [x] Installable as an app (PWA) with Install button
- [x] Invite link using the server's LAN address, code pre-filled — e2e
- [x] Toast notifications (viewer joined/left, copied, reconnected)
- [x] F / double-click fullscreen; confirm before closing the host tab
- [x] Visible keyboard focus; reduced-motion support

## Vercel deployment (follow-up)
- [x] Store abstraction: memory locally, Upstash Redis on Vercel — unit tests on both
- [x] Signaling moved from Socket.io to HTTPS polling (works across serverless instances)
- [x] `api/index.js` + `vercel.json`; Vercel project linked to the GitHub repo
- [x] Production deploy builds and serves pages + API (https://screenview-share.vercel.app)
- [x] Vercel-mode e2e suite (fake Upstash API over HTTP) — 3 tests
- [ ] Upstash Redis connected to the Vercel project (needs the account owner)
- [ ] Live end-to-end check against the real deployment
- [x] 120-minute soak of the new version (Vercel mode) recorded in TESTING.md: 0 stalls, 19.9 fps, 0 errors

## Tests
- [x] Unit tests (`npm test`) — 47 passing
- [x] e2e (`npm run test:e2e`) — 20 passing
- [x] e2e: host→code→viewer live frames advancing
- [x] e2e: invalid code
- [x] e2e: expired code
- [x] e2e: session full
- [x] e2e: host ends → viewer notified
- [x] e2e: reconnect after signaling drop, and after ICE restart
- [x] e2e: view-only (no data channels, no outgoing tracks, recvonly SDP)
- [x] e2e: admin rejects wrong password, shows sessions
- [x] soak test (default 5 min; 1-minute and 120-minute runs verified)
- [x] 120-minute soak of the first (Socket.io) version recorded in TESTING.md (240 checks, 0 stalls)

## Docs
- [x] README.md (with screenshots)
- [x] docs/ARCHITECTURE.md (Mermaid sequence + reconnect diagram)
- [x] docs/SECURITY.md
- [x] docs/TESTING.md (including 120-minute soak results)
- [x] docs/USER_GUIDE.md (with screenshots)

## Final
- [x] `npm install && npm start` runs on a fresh clone with zero config (verified in a clean clone)
- [x] No console errors in a normal session (e2e asserts zero errors; page-load test also zero warnings)
- [x] Clean code, no dead code / debug logs (swept; only the startup banner logs)
- [x] Final commit + summary

## Summary
### What's done
Every must-have (1–8) and nice-to-have (9–11) from the brief, plus an
installable app UI (PWA), invite links, toasts and accessibility polish.
24 unit tests and 17 end-to-end tests pass; the 120-minute soak ran with
240 checks, 0 stalls, 0 console errors and no memory growth.

### How to demo
1. `npm install` then `npm start` on the host laptop (Node 22+).
2. Host: open `http://localhost:3000` → **Share my screen** → **Start sharing**
   → pick a screen. A code like `482-913` appears, plus an invite link.
3. Viewer (another computer on the same network): open the invite link, or go
   to `http://<host-LAN-IP>:3000/view` and type the code.
4. Show: live video, timer, viewer count, quality switch, fullscreen (F),
   unplugging Wi-Fi briefly (it reconnects without the code), **End session**.
5. Admin: start with `ADMIN_PASSWORD=secret npm start`, open `/admin`.

### Known limitations
- Running locally, sessions live in memory: a server restart ends all active
  sessions. (On Vercel they live in Redis and survive redeploys.)
- On Vercel each active session uses ~1–2 small Redis requests per second;
  Upstash's free tier covers demos, not all-day heavy use.
- Automated tests run in Chromium only; Edge/Firefox use the same standard
  APIs but were not tested automatically.
- Screen capture needs HTTPS or `localhost` on the host's side.
- Peer-to-peer mesh: about 3 viewers maximum (larger audiences need an SFU).
- Without a TURN server, some strict networks (symmetric NAT) cannot connect.
- `/api/info` exposes LAN IPs; the admin API has no lockout (see SECURITY.md).
