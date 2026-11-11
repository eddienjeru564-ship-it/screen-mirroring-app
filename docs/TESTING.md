# Testing

## Strategy

| Layer | Tool | What it covers | Command |
|---|---|---|---|
| Unit | `node --test` | Session/code logic, rate limiter, log writer/reader. Pure functions with an injected clock, so expiry and grace periods are tested in microseconds. | `npm test` |
| End-to-end | Playwright + Chromium | Real host and viewer pages in separate browser contexts, real Socket.io signaling, real WebRTC between them. | `npm run test:e2e` |
| Soak | Playwright | One live session held for `SOAK_MINUTES`, checked every 30 s. | `npm run test:soak` |

The e2e config starts three servers with different settings so each scenario
can be tested quickly:

| Port | Settings | Used by |
|---|---|---|
| 3100 | defaults, `MAX_VIEWERS=1`, admin password `test-admin` | most tests, soak |
| 3101 | `CODE_EXPIRY_MS=1500`, `GRACE_MS=2000` | expired code, host-timeout |
| 3102 | `RATE_LIMIT_MAX=3` | brute-force test |

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
`window.screenview.dropSignaling()` (closes the Socket.io transport, as a
network blip would) and, on the host, `forceIceRestart()` (calls
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
| 7 | browser "Stop sharing" | track `ended` ends the session for the viewer |
| 8 | signaling drop | both sockets dropped → rejoin → new offer → frames resume, viewer never returns to code entry |
| 9 | ICE restart | `restartIce()` → new offer → frames keep advancing |
| 10 | view-only | 0 data channels, 0 outgoing tracks, no `m=application`, all media `recvonly` |
| 11 | password | missing/wrong password rejected; right one works |
| 12 | rate limiting | 4th wrong code in a minute → "Too many attempts" |
| 13 | admin | wrong password rejected; right one lists the ended session with `host_ended` |
| 14 | host vanishes | host tab closed → viewer sees "Host disconnected" after the grace period |

## Results

Latest full run (Chromium, Linux, headless):

```
unit:  20 passed, 0 failed
e2e:   14 passed, 0 failed  (≈32 s; run 3× in a row with no flakes)
```

## 120-minute soak test

SOAK_RESULTS_PLACEHOLDER
