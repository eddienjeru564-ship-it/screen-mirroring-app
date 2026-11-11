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

## Tests
- [x] Unit tests (`npm test`) — 24 passing
- [x] e2e (`npm run test:e2e`) — 17 passing, repeated runs with no flakes
- [x] e2e: host→code→viewer live frames advancing
- [x] e2e: invalid code
- [x] e2e: expired code
- [x] e2e: session full
- [x] e2e: host ends → viewer notified
- [x] e2e: reconnect after signaling drop, and after ICE restart
- [x] e2e: view-only (no data channels, no outgoing tracks, recvonly SDP)
- [x] e2e: admin rejects wrong password, shows sessions
- [x] soak test (default 5 min; 1-minute run verified)
- [ ] 120-minute soak run recorded in TESTING.md

## Docs
- [x] README.md (with screenshots)
- [x] docs/ARCHITECTURE.md (Mermaid sequence + reconnect diagram)
- [x] docs/SECURITY.md
- [x] docs/TESTING.md (soak results pending)
- [x] docs/USER_GUIDE.md (with screenshots)

## Final
- [x] `npm install && npm start` runs on a fresh clone with zero config (verified in a clean clone)
- [x] No console errors in a normal session (e2e asserts zero errors; page-load test also zero warnings)
- [x] Clean code, no dead code / debug logs (swept; only the startup banner logs)
- [ ] Final commit + summary

## Summary
_(filled in after the 120-minute soak finishes)_
