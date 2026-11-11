# ScreenView

View-only live screen sharing in the browser, joined with a 6-digit code.

A **host** clicks *Start sharing*, picks a screen, and gets a code like
`482-913`. A **viewer** types the code and watches the host's screen live.
The viewer can never control the host: there is no control channel at all.
Nothing to install for either person.

![Host sharing](docs/img/host-live.png)
![Viewer watching](docs/img/viewer-watching.png)

## Features

- 6-digit join codes from `crypto.randomInt`; unused codes expire after 10 min,
  ended codes never work again
- Peer-to-peer WebRTC video; the server only relays signaling
- View-only by design: viewer is `recvonly`, no data channel (tested)
- Built for long sessions: automatic ICE restart, Socket.io auto-reconnect with
  automatic rejoin (no re-entering the code), 60 s grace period for the host
- Host dashboard: code, viewer count, session timer, live quality switch, End
  session; the browser's own "Stop sharing" button also ends the session
- Viewer: auto-formatted code box, clear error messages, fullscreen,
  connection badge, reconnecting overlay
- Optional session password, brute-force rate limiting, Low/Medium/High quality
- Session log (`logs/sessions.jsonl`) and a password-protected `/admin` page
- **Installable as an app** (Chrome/Edge "Install app" button): opens in its own
  window with its own icon, no app store or installer needed
- One-click **invite link** for the viewer that uses the host's network address
  and opens with the code already filled in
- Notifications when a viewer joins or leaves; **F** or double-click for fullscreen

## Quick start

Requires Node.js 22 LTS or newer.

```bash
npm install
```

```bash
npm start
```

**Simplest setup (same network):** run `npm start` on the **host's** laptop.

- The host opens <http://localhost:3000> and clicks *Start sharing*.
- The viewer opens `http://<host-laptop-IP>:3000` (e.g. `http://192.168.1.20:3000`)
  and enters the code.

> Browsers only allow screen *capture* on `localhost` or over **HTTPS**, which
> is why the host uses `localhost`. Watching works over plain HTTP. To run the
> server somewhere else (a school server, the cloud), put it behind HTTPS, e.g.
> with a reverse proxy such as Caddy, and configure TURN for viewers outside
> the LAN.

## Configuration

All settings are optional environment variables (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | *(unset)* | Enables `/admin`; disabled when unset |
| `CODE_EXPIRY_MS` | `600000` | Lifetime of an unused code (10 min) |
| `GRACE_MS` | `60000` | How long a session survives a host disconnect |
| `MAX_VIEWERS` | `1` | Viewers per session (1–3) |
| `RATE_LIMIT_MAX` | `5` | Failed join attempts allowed per IP… |
| `RATE_LIMIT_WINDOW_MS` | `60000` | …per this window |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | *(unset)* | Optional TURN server; STUN-only without it |
| `LOG_FILE` | `logs/sessions.jsonl` | Session log location |

Example:

```bash
ADMIN_PASSWORD=s3cret MAX_VIEWERS=3 npm start
```

## Tests

```bash
npm test
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

```bash
SOAK_MINUTES=120 npm run test:soak
```

24 unit tests and 17 end-to-end tests; a 120-minute soak run is recorded in
[docs/TESTING.md](docs/TESTING.md). `npm run screenshots` regenerates the
images in `docs/img/`; `npm run icons` regenerates the app icons.

## Project layout

```
server/   index.js (Express + Socket.io), sessions.js, rateLimit.js, logger.js
public/   index/host/view/admin pages, rtc.js (shared WebRTC helpers), app.js
          (install + toasts), sw.js (service worker), manifest.webmanifest, icons/
tests/    unit/ (node --test), e2e/ (Playwright, incl. soak.spec.js)
docs/     ARCHITECTURE, SECURITY, TESTING, USER_GUIDE, img/
scripts/  screenshots.js, icons.js
```

## Documentation

- [User guide](docs/USER_GUIDE.md): step-by-step for hosts and viewers
- [Architecture](docs/ARCHITECTURE.md): components, sequence and reconnect diagrams
- [Security](docs/SECURITY.md): why view-only is guaranteed, codes, rate limiting, logging, limitations
- [Testing](docs/TESTING.md): strategy, headless WebRTC, soak results
- [DECISIONS.md](DECISIONS.md): design decisions made during the build
