# Testing

## Strategy

| Layer | Tool | What it covers | Command |
|---|---|---|---|
| Unit | `node --test` | Session/code logic, signaling relay rules, presence and rejoin, rate limiter, both stores, log writer/reader, and the connection monitor that triggers ICE restarts on `failed` (immediately) or `disconnected` (after 3 s). An injected clock tests expiry and grace periods in microseconds. **Every store and session test runs twice: on the memory store and on the Upstash store against a fake Upstash REST API** (`tests/unit/fakeUpstash.js`), so the Redis command encoding used on Vercel is tested too. | `npm test` |
| End-to-end | Playwright + Chromium | Real host and viewer pages in separate browser contexts, real HTTP signaling, real WebRTC between them. Includes a suite that runs the app in **Vercel mode** (`VERCEL=1`, Upstash store over HTTP). | `npm run test:e2e` |
| Soak | Playwright | One live session held for `SOAK_MINUTES`, checked every 30 s. | `npm run test:soak` |

The e2e config starts these servers with different settings so each scenario
can be tested quickly (all use `VIEWER_STALE_MS=3000` so the reconnect test is
short):

| Port | Settings | Used by |
|---|---|---|
| 3100 | defaults, `MAX_VIEWERS=1`, admin password `test-admin` | most tests, soak |
| 3101 | `CODE_EXPIRY_MS=1500` | expired code |
| 3102 | `RATE_LIMIT_MAX=3` | brute-force test |
| 3103 | `GRACE_MS=2000` | host vanishes (grace-period teardown) |
| 3104 | `VERCEL=1` + Upstash store pointing at the fake Upstash API on 3110 | Vercel-mode tests, Vercel-mode soak |
| 3105 | `VERCEL=1`, no store | "storage missing" error test |
| 3110 | fake Upstash REST API (`tests/e2e/fakeUpstashServer.js`) | backs 3104 |

Ports shift with `E2E_PORT_BASE` (e.g. `E2E_PORT_BASE=3300`), so the suite can
run while a soak test holds the default ports.

Test servers write to `test-results/sessions-<port>.jsonl`, never to the real
`logs/sessions.jsonl`.

## How headless WebRTC testing works

Chromium is launched with:

```
--use-fake-ui-for-media-stream            auto-accept permission prompts
--use-fake-device-for-media-stream        fake capture devices
--auto-select-desktop-capture-source=Entire screen
--disable-features=WebRtcHideLocalIpsWithMdns   real host ICE candidates, so two
                                                pages on one machine connect without STUN
--autoplay-policy=no-user-gesture-required
```

Even with these flags, `getDisplayMedia()` can't be given predictable,
continuously changing frames in headless mode (there is no flag to feed it a
file). So, as allowed by the brief, the host page has a **test-only source**:
opening `/host?test=1` replaces `getDisplayMedia()` with an animated
`<canvas>` (a frame counter and a moving square) captured with
`canvas.captureStream(30)`. Everything after capture — peer connection,
encoding, network, decoding — is the real production code path.
Without `?test=1` the page always uses the real `getDisplayMedia()`.

`?test=1` also exposes two hooks that the reconnect tests need:
`window.screenview.dropSignaling(ms)` (stops all signaling requests for `ms`,
as a network outage would) and, on the host, `forceIceRestart()` (calls
`pc.restartIce()`).

"Frames advancing" is measured with
`video.getVideoPlaybackQuality().totalVideoFrames` on the viewer.

### Running the e2e tests

```bash
npx playwright install chromium   # once, downloads the browser
npm run test:e2e
```

If a Chromium is already installed elsewhere (e.g. a CI image), point to it
instead of downloading: `CHROMIUM_PATH=/path/to/chrome npm run test:e2e`.

## e2e test list

| # | Test | Checks |
|---|---|---|
| 1 | host shares, viewer joins | `videoWidth > 0`, `totalVideoFrames` increasing, status "Connected", host shows 1 viewer, timer runs, **no console errors on either page** |
| 2 | invalid code | "isn't valid" error |
| 3 | code input auto-format | typing `482913` shows `482-913` |
| 4 | expired code | "expired" error after 1.5 s |
| 5 | session full | 2nd viewer gets "full" |
| 6 | host ends session | viewer sees "Session ended"; code no longer works |
| 7 | browser "Stop sharing" | track `ended` ends the session; viewer sees "Sharing stopped" |
| 8 | signaling drop | host offline 3 s, viewer offline 4.5 s (longer than `VIEWER_STALE_MS`, so it is counted as gone) → viewer re-admitted by token → new offer → frames resume, viewer never returns to code entry |
| 9 | ICE restart | `restartIce()` → new offer → frames keep advancing |
| 10 | view-only | 0 data channels, 0 outgoing tracks, no `m=application`, all media `recvonly` |
| 11 | password | missing/wrong password rejected; right one works |
| 12 | rate limiting | 4th wrong code in a minute → "Too many attempts" |
| 13 | admin | wrong password rejected; right one lists the ended session with `host_ended` |
| 14 | host vanishes | host tab closed → viewer sees "Host disconnected" after the grace period |
| 15 | quality presets | Low → viewer receives 640 px wide; switching to High live → 1280 px |
| 16 | clean pages + installable | `/`, `/host`, `/view`, `/admin`: zero console errors **or warnings**, zero failed or 4xx/5xx requests, service worker registers; Chrome's own `Page.getInstallabilityErrors` reports no manifest problems |
| 17 | invite link | link uses the LAN address (not `localhost`), opens the viewer with the code filled in, joins, host gets a "now watching" notification |
| 18 | Vercel mode: full session | health reports the Upstash store; live video; invite link uses the site's own address; viewer offline 4.5 s → rejoins without the code; host ends; zero console errors; admin log read back from Redis |
| 19 | Vercel mode: limits | session full, and the ended code is refused, across independent requests |
| 20 | Vercel mode without storage | host sees a clear "session storage (Redis) is missing" message instead of a half-working site |

## Results

Latest full run (Chromium, Linux, headless):

```
unit:  24 passed, 0 failed
e2e:   17 passed, 0 failed  (35–60 s depending on machine load; run repeatedly with no flakes)
```

## 120-minute soak tests

### Run 2: current version, Vercel mode over Redis

SOAK2_PLACEHOLDER

### Run 1: first version (Socket.io signaling, before the Vercel rework)

Run once with `SOAK_MINUTES=120 npm run test:soak` (headless Chromium, host and
viewer in separate browser contexts on one 4-core Linux container, Node 22,
test canvas source at 30 fps, default "Medium" quality).

| Measure | Result |
|---|---|
| Started | 2026-11-11 20:01:25 UTC |
| Duration | 120 minutes (Playwright: `1 passed (2.0h)`) |
| Frame checks (every 30 s) | 240 |
| Stalls (frames did not advance) | **0** |
| Frames decoded by the viewer | 140,894 |
| Average received frame rate | 19.6 fps (Medium preset caps at 20 fps) |
| Renegotiations / ICE restarts needed | 0 |
| Viewer JS heap, start → end | 3.1 MB → 2.8 MB (no growth, so no leak) |
| Console errors | 0 |

Raw result line:

```
SOAK_RESULT {"minutes":120,"checks":240,"stalls":0,"framesDecoded":140894,"avgFps":19.6,"renegotiations":0,"viewerHeapStartMB":3.1,"viewerHeapEndMB":2.8,"consoleErrors":0}
```

Note: both browsers ran on the same machine, so this proves the app logic
(timers, peer connection, memory) holds up for 2 hours. It does not test a
real Wi-Fi network; the network-failure paths are covered by the reconnect
and ICE-restart e2e tests instead.
