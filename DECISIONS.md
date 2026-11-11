# Design decisions & ambiguity log

This file records choices made autonomously while building ScreenView, per the
build brief ("when something is ambiguous, pick the most reasonable option, note
it here, and keep going").

## The "no indicator" side note — scope and safety boundary
The brief ends with: *"the screen that's being viewed there shouldn't be any
icons or anything showing that it is being viewed by another machine."*

Interpretation and decision:
- **The host always consents and initiates.** Screen sharing only ever starts
  when the host clicks "Start sharing" and the browser's native picker prompts
  them to choose a screen/window. There is no way in this app (or in any web
  app) to start capture without that deliberate host action.
- **We do not paint anything onto the shared image.** The stream the viewer
  receives is the host's raw screen — no watermark, no "you are being watched"
  badge, no overlay is composited onto the video. The host's own app UI (code,
  timer, viewer count) lives in the ScreenView browser tab, not on the captured
  content, so it does not appear in what the viewer sees unless the host chooses
  to share that very tab.
- **The browser's own sharing indicator is intentionally left in place.**
  Chrome/Edge/Firefox display an OS/browser-level "You are sharing your screen"
  banner/indicator for any `getDisplayMedia()` session. This is enforced by the
  browser and **cannot be removed by web code** — nor would we try to. It is a
  core safety guarantee that the person whose screen is captured knows it is
  being captured. ScreenView is a consensual screen-sharing tool, not covert
  monitoring, so this indicator stays.

Net effect: the *content* being viewed is clean (no app chrome overlaid on it),
which is what a screen-sharing tool should do, while the host remains fully
aware they are sharing.

## Signaling / WebRTC topology
- **Host is the sole offerer; viewer is `recvonly` and never offers.** Because
  the viewer adds no tracks and no data channel, negotiation is one-directional
  (host → offer, viewer → answer). This removes "glare" entirely, so we did not
  need the full Perfect Negotiation rollback dance. ICE restarts are always
  initiated by the host.
- **One `RTCPeerConnection` per viewer (mesh from the host).** Simpler than an
  SFU and fine for `MAX_VIEWERS` ≤ 3. Decision: `MAX_VIEWERS` default 3.
- **No data channel is ever created, on either side.** This is the structural
  guarantee of "view-only by design" — there is no transport for viewer→host
  input to travel over. Verified by an e2e test.

## Reconnection
- Socket.io auto-reconnect handles signaling drops. Socket ids change on
  reconnect, so each participant holds a stable server-issued token
  (`hostToken` / `viewerToken`) and calls a `rejoin` event. The server
  re-associates the new socket and triggers renegotiation — **no code
  re-entry**.
- On the P2P layer, `connectionstatechange`/`iceconnectionstatechange` of
  `failed` (and a debounced `disconnected`) triggers `host.restartIce()`, which
  fires `negotiationneeded` and a fresh offer carrying new ICE credentials.
- Research note (bloggeek.me, MDN restartIce, Mozilla "Just Begin Again"):
  restarting on `failed` is standard; some apps restart earlier on
  `disconnected`. We restart on `failed` immediately and on `disconnected` after
  a short debounce, because `disconnected` is often transient.

## Testing getDisplayMedia headlessly
- Chromium's fake-device flags produce a generic test pattern for display
  capture and cannot be pointed at a deterministic source, and there is no flag
  to feed a file to `getDisplayMedia` (confirmed via chromium-discuss threads).
- Decision: a **test-only host source** behind `?test=1` generates an animated
  `<canvas>` and uses `canvas.captureStream()` in place of `getDisplayMedia()`.
  This gives deterministic, always-advancing frames so e2e tests can assert
  `videoWidth > 0` and increasing `totalVideoFrames`. Documented in TESTING.md.
  Production (no `?test=1`) always uses the real `getDisplayMedia()`.

## Storage & logging
- In-memory session manager; append-only `logs/sessions.jsonl` for the audit
  log. One JSON line per event (`session_start`, `viewer_join`, `viewer_leave`,
  `session_end`). The `/admin` page reconstructs per-session rows from these.

## Code generation
- 6 digits, formatted `NNN-NNN`, generated with `crypto.randomInt` (not
  `Math.random`), re-rolled on collision with an active session. Unused codes
  expire after `CODE_EXPIRY_MS`; once a session ends the code is dead forever.

## Config
- Everything is env-driven with LAN-friendly defaults; TURN is optional and only
  read from `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL`. The client fetches ICE
  config from `GET /api/ice-config` so TURN credentials are not hardcoded in
  static files.
