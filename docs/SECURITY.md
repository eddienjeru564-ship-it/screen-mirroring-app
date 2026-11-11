# Security

## 1. View-only is guaranteed by design

ScreenView does not have a "remote control" feature that is switched off. The
pieces needed for control do not exist anywhere in the code:

- **No data channel.** Neither page ever calls `createDataChannel()`. Without a
  data channel there is no WebRTC path for keyboard or mouse events.
- **The viewer sends no media.** `view.js` never calls `addTrack()`. Its peer
  connection only answers the host's offer, so every media section in its SDP
  is `recvonly`.
- **The host never reads viewer input.** `host.js` listens for only two things
  from viewers: SDP answers and ICE candidates. There is no handler that could
  move a mouse or press a key. A web page cannot control the operating system
  anyway, even if it wanted to.
- **The server only relays signaling.** The `signal` handler forwards
  `description`/`candidate` objects between one host and its own viewers. It
  checks that the sender belongs to that session; a viewer can only send to its
  own host.

The e2e test *"viewer is view-only"* checks this on a live session: zero data
channels, zero outgoing tracks, no `m=application` section in the SDP, and
every media section `recvonly`.

## 2. The host always knows they are sharing

Capture only starts after the host clicks **Start sharing** and picks a screen
in the browser's own picker. While sharing, Chrome, Edge and Firefox show their
own "you are sharing your screen" indicator. Web pages cannot hide it, and
ScreenView does not try to. ScreenView adds no overlay or watermark to the
video itself; the host's dashboard is in its own tab and is not drawn onto the
stream.

## 3. Join codes

| Property | Value |
|---|---|
| Format | 6 digits, shown as `NNN-NNN` |
| Space | 1,000,000 codes |
| Generator | `crypto.randomInt` (cryptographically secure, not sequential) |
| Uniqueness | Re-rolled if it collides with an active session |
| Unused lifetime | 10 min (`CODE_EXPIRY_MS`) |
| After the session ends | Dead forever; for 1 hour the server still reports "ended/expired" instead of "invalid" |

Six digits alone is a small space, so it is protected by the measures below
rather than by size alone.

## 4. Brute-force protection (rate limiting)

Each IP gets **5 failed join attempts per minute** (`RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW_MS`). Wrong codes, wrong passwords, expired and ended codes
all count. A correct join clears the counter, so real users are not slowed down.

Rough estimate: with ~10 active sessions, one IP at 5 guesses/min has about a
5 × 10 / 1,000,000 = 0.005 % chance per minute, or roughly 0.5 % over 10 minutes.
A determined attacker with many IPs could do better; that is why the optional
password exists and why MAX_VIEWERS defaults to 1 (a guessed code is useless
if the real viewer has already joined).

## 5. Optional session password

The host can set a password. The viewer then needs both the code and the
password. The password is kept only in server memory for the life of the
session, is never written to the log (the log records only `hasPassword`), and
is compared on the server.

## 6. TURN credentials

TURN is optional and only read from environment variables (`TURN_URL`,
`TURN_USERNAME`, `TURN_CREDENTIAL`). They are never in the static files or in
git (`.env` is git-ignored). Browsers need TURN credentials to use a TURN
server, so `/api/ice-config` does send them to clients. For a public deployment,
use short-lived TURN credentials (e.g. coturn's REST-API shared-secret mode) so
a leaked credential expires quickly.

## 7. Media encryption

WebRTC encrypts all media with DTLS-SRTP; this cannot be turned off. Video goes
browser-to-browser (or through TURN, which only sees encrypted packets). The
signaling server never sees video. For deployment beyond a LAN, put the server
behind HTTPS: browsers require a secure context for `getDisplayMedia` anyway
(`localhost` is the exception used during development).

## 8. What is logged

`logs/sessions.jsonl`, one JSON object per line:

| Event | Fields |
|---|---|
| `session_start` | time, sessionId, code, hasPassword, quality |
| `viewer_join` / `viewer_leave` | time, sessionId, random viewerId |
| `session_end` | time, sessionId, code, endReason, duration |

Not logged: IP addresses, passwords, names, or any screen content.

## 9. Admin page

`/admin` asks for `ADMIN_PASSWORD`; the page sends it in an `x-admin-password`
header to `/api/admin/sessions`. If `ADMIN_PASSWORD` is not set, the admin API
is disabled (HTTP 503) rather than open. Table cells are filled with
`textContent`, so log data cannot inject HTML.

## 10. Known limitations

- Sessions live in memory. If the server process restarts, active sessions are
  lost; the host must start a new one. (Socket drops and network changes are
  handled; a full server restart is not.)
- The admin password is compared directly, with no lockout on the admin API.
  Use a long password and HTTPS.
- Rate limiting is per IP. Many viewers behind one NAT share a budget, and an
  attacker with many IPs is limited per IP only.
- `/api/ice-config` hands TURN credentials to anyone who loads it (needed by
  design); see section 6.
- `/api/info` lists the server's LAN IPv4 addresses (used to build the invite
  link). On a LAN this is harmless; on a public server it reveals internal
  addresses, so remove the endpoint or put the server behind a proxy that hides it.
- No user accounts: anyone who has the code (and password, if set) can watch.
- Mesh topology: each viewer is a separate upload from the host, so 3 viewers
  is the practical maximum.
