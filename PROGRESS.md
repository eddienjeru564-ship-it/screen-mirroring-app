# ScreenView — progress

Checklist tracks every feature and Definition-of-Done item. A box is checked
only after the thing has been **run and verified**, not when the code is merely
written.

## Setup
- [x] Project scaffold, git init, package.json, .env.example
- [x] Research notes recorded in DECISIONS.md

## Server
- [ ] `sessions.js` — code generation, expiry, viewer limits, lifecycle (unit-tested)
- [ ] `logger.js` — append-only jsonl session log
- [ ] `rateLimit.js` — per-IP code-attempt limiting (unit-tested)
- [ ] `index.js` — Express + Socket.io, static serving, signaling, ICE config, admin

## Frontend
- [ ] `index.html` — landing (Share / View)
- [ ] `host.html` + `host.js`
- [ ] `view.html` + `view.js`
- [ ] `admin.html` + `admin.js`
- [ ] `rtc.js` — shared WebRTC helpers
- [ ] `styles.css`

## Must-have features
- [ ] 1. 6-digit unique, non-sequential code (crypto.randomInt)
- [ ] 2. Unused code expires (configurable); ended session's code dead forever
- [ ] 3. One viewer per session (MAX_VIEWERS configurable, up to 3)
- [ ] 4. View-only by design: recvonly, no data channel, no input path
- [ ] 5. 2-hour stability: drop detection, ICE restart, socket reconnect+rejoin, heartbeat/grace, track.onended
- [ ] 6. Host controls: End session, visible code, viewer indicator, timer
- [ ] 7. Viewer UX: auto-formatting input, error states, fullscreen, status badge, reconnecting indicator
- [ ] 8. Session log + password-protected /admin table

## Nice-to-have
- [ ] 9. Optional host-set session password
- [ ] 10. Rate limiting on code attempts
- [ ] 11. Adaptive quality (Low/Med/High)

## Tests
- [ ] Unit tests (node --test) — sessions + rateLimit
- [ ] e2e: host→code→viewer live frames advancing
- [ ] e2e: invalid code
- [ ] e2e: expired code
- [ ] e2e: session full
- [ ] e2e: host ends → viewer notified
- [ ] e2e: reconnect after signaling drop / ICE restart
- [ ] e2e: view-only (no data channels, no outgoing tracks)
- [ ] e2e: admin rejects wrong password, shows sessions
- [ ] soak test (default 5 min) + 120-min run recorded in TESTING.md

## Docs
- [ ] README.md (with screenshots)
- [ ] docs/ARCHITECTURE.md (Mermaid sequence + reconnect diagram)
- [ ] docs/SECURITY.md
- [ ] docs/TESTING.md (+ 120-min soak result)
- [ ] docs/USER_GUIDE.md (with screenshots)

## Final
- [ ] npm install && npm start runs on a fresh clone with zero config
- [ ] No console errors in a normal session
- [ ] Clean code, no dead code / debug logs
- [ ] Final commit + summary

## Summary
_(filled in after final verification pass)_
