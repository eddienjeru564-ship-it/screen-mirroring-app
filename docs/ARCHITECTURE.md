# Architecture

ScreenView has three parts: a **host page**, a **viewer page**, and one **Node
server**. The server serves the pages and relays signaling messages. Video never
passes through the server: once connected, it flows directly between the two
browsers over WebRTC.

```
 Host browser                    Node server                     Viewer browser
┌──────────────┐  Socket.io   ┌─────────────────────┐  Socket.io  ┌──────────────┐
│ host.js      │◄────────────►│ index.js (relay)    │◄───────────►│ view.js      │
│ getDisplay-  │  signaling   │ sessions.js (codes) │  signaling  │ recvonly     │
│ Media()      │              │ rateLimit.js        │             │ <video>      │
│ RTCPeerConn. │              │ logger.js → .jsonl  │             │ RTCPeerConn. │
└──────┬───────┘              └─────────────────────┘             └──────▲───────┘
       │                 screen video, peer-to-peer (WebRTC/SRTP)        │
       └─────────────────────────────────────────────────────────────────┘
```

## Components

| File | Role |
|---|---|
| `server/index.js` | Express app (static files, `/api/ice-config`, `/api/admin/sessions`) and the Socket.io signaling relay. Handles disconnects, the grace period, and the periodic sweep. |
| `server/sessions.js` | Pure session logic: code generation (`crypto.randomInt`), expiry, viewer limit, passwords, rejoin tokens. No I/O, so it is unit-tested directly. |
| `server/rateLimit.js` | Sliding-window limiter on failed join attempts per IP. |
| `server/logger.js` | Append-only JSON-lines audit log, plus folding it into per-session rows for `/admin`. |
| `public/rtc.js` | Shared WebRTC helpers: ICE config fetch, quality presets, connection-health monitor. |
| `public/host.js` | Captures the screen, creates the session, keeps one `RTCPeerConnection` per viewer, performs ICE restarts. |
| `public/view.js` | Code entry, answer-only peer connection, status/reconnect UI, fullscreen. |
| `public/admin.js` | Password-protected session table. |

## Key design choices

- **Host is the only offerer.** The viewer adds no tracks and no data channel,
  so negotiation only ever goes host → offer, viewer → answer. Two sides can
  never offer at the same time ("glare"), which keeps the code simple.
- **One peer connection per viewer.** Fine for up to 3 viewers. A larger
  audience would need a media server (SFU); see SECURITY.md → limitations.
- **Stable identities across reconnects.** Socket.io gives a new socket id on
  every reconnect. The server therefore hands the host a `hostToken` and each
  viewer a `viewerId` + `viewerToken`; signaling is addressed by these, not by
  socket id.
- **In-memory sessions.** No database is needed for live sessions. The
  `.jsonl` log is the durable record.

## Connection flow

```mermaid
sequenceDiagram
    autonumber
    participant H as Host browser
    participant S as Server
    participant V as Viewer browser

    H->>H: getDisplayMedia() — user picks a screen
    H->>S: host:create {quality, password?}
    S-->>H: {code "482-913", sessionId, hostToken}
    Note over H: shows code + timer

    V->>S: viewer:join {code, password?}
    S->>S: check code, expiry, password, limit, rate limit
    S-->>V: {sessionId, viewerId, viewerToken}
    S->>H: viewer:joined {viewerId}

    H->>H: new RTCPeerConnection, addTrack(screen)
    H->>S: signal {to: viewerId, offer}
    S->>V: signal {from: host, offer}
    V->>V: setRemoteDescription, createAnswer
    V->>S: signal {to: host, answer}
    S->>H: signal {from: viewer, answer}

    par trickle ICE
        H->>S: signal {candidate}
        S->>V: signal {candidate}
    and
        V->>S: signal {candidate}
        S->>H: signal {candidate}
    end

    H-)V: screen video, peer-to-peer (server not involved)
```

## Reconnect flows

Two different things can break during a long session, and each has its own
recovery path. Neither one asks the viewer for the code again.

```mermaid
sequenceDiagram
    autonumber
    participant H as Host
    participant S as Server
    participant V as Viewer

    rect rgba(108,140,255,0.12)
    Note over H,V: A) Signaling drop (Wi-Fi blip, socket closed)
    V--xS: socket disconnects
    S->>S: mark viewer left, tell host
    V->>S: (auto-reconnect) viewer:rejoin {sessionId, viewerId, viewerToken}
    S->>H: viewer:joined {viewerId}
    H->>V: fresh offer → answer → ICE (via S)
    Note over H: if the HOST socket drops instead, the server keeps the<br/>session for GRACE_MS (60 s). host:rejoin {hostToken}<br/>returns the viewer list and the host re-offers to each.
    end

    rect rgba(55,211,153,0.12)
    Note over H,V: B) Media path failure (network change, NAT rebinding)
    H->>H: connectionState = failed<br/>(or disconnected for 3 s)
    H->>H: pc.restartIce()
    H->>S: offer with new ICE credentials
    S->>V: offer
    V->>S: answer
    S->>H: answer
    H-)V: video resumes on the new path
    end
```

If the host does not come back within the grace period, the sweep ends the
session with reason `host_timeout` and every viewer sees "Host disconnected".

## Session lifecycle

```
            host:create                first viewer joins
  (none) ─────────────► waiting ─────────────────────────► live
                           │                                 │
       CODE_EXPIRY_MS ─────┤                                 ├── host:end / Stop sharing
       passes (sweep)      ▼                                 ├── host gone > GRACE_MS
                         ended ◄─────────────────────────────┘
                 (code removed; never joinable again)
```

## Signaling messages

| Event | Direction | Payload |
|---|---|---|
| `host:create` | H → S | `{quality, password?}` → ack `{code, codePretty, sessionId, hostToken}` |
| `host:rejoin` | H → S | `{sessionId, hostToken}` → ack `{viewers: [viewerId]}` |
| `viewer:join` | V → S | `{code, password?}` → ack `{sessionId, viewerId, viewerToken}` or `{error}` |
| `viewer:rejoin` | V → S | `{sessionId, viewerId, viewerToken}` |
| `viewer:joined` / `viewer:left` | S → H | `{viewerId}` |
| `signal` | both | `{to, data: {description} | {candidate}}`, relayed as `{from, data}` |
| `host:quality` | H → S | `{quality}` |
| `host:end` | H → S | — |
| `session:viewers` | S → room | `{count, max}` |
| `session:ended` | S → room | `{reason}` |
