// rtc.js — WebRTC helpers shared by host and viewer.
//
// Keeps ICE configuration, quality presets, and connection-health monitoring in
// one place. No data channels are ever created here — "view-only by design"
// means there is simply no transport for viewer→host input.

let cachedIce = null;

/** Fetch ICE servers (STUN, optional TURN) and server limits from the backend. */
export async function fetchIceConfig() {
  if (cachedIce) return cachedIce;
  try {
    const res = await fetch('/api/ice-config');
    cachedIce = await res.json();
  } catch {
    // Fall back to Google STUN if the endpoint is unreachable.
    cachedIce = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxViewers: 1 };
  }
  return cachedIce;
}

/** Quality presets applied to the host's outbound video sender. */
export const QUALITY = {
  low: { maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 10 },
  medium: { maxBitrate: 1_800_000, scaleResolutionDownBy: 1, maxFramerate: 20 },
  high: { maxBitrate: 5_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
};

/** Apply a quality preset to an RTCRtpSender (host side). Safe if unsupported. */
export async function applyQuality(sender, quality) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  const preset = QUALITY[quality] || QUALITY.medium;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = preset.maxBitrate;
    params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;
    params.encodings[0].maxFramerate = preset.maxFramerate;
    await sender.setParameters(params);
  } catch {
    /* some browsers reject certain params mid-call; ignore and keep streaming */
  }
}

/**
 * Watch a peer connection's health and invoke callbacks on state changes.
 * Returns a cleanup function.
 *
 * @param {RTCPeerConnection} pc
 * @param {object} handlers
 * @param {(state:string)=>void} [handlers.onState]      any connection-state change
 * @param {()=>void} [handlers.onFailed]                 failed/disconnected (restart point)
 * @param {()=>void} [handlers.onConnected]              (re)connected
 */
export function monitorConnection(pc, { onState, onFailed, onConnected } = {}) {
  let disconnectTimer = null;

  const clearTimer = () => {
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
  };

  const evaluate = () => {
    const state = pc.connectionState || pc.iceConnectionState;
    onState?.(state);
    if (state === 'connected' || state === 'completed') {
      clearTimer();
      onConnected?.();
    } else if (state === 'failed') {
      // Hard failure: recover immediately.
      clearTimer();
      onFailed?.();
    } else if (state === 'disconnected') {
      // Often transient — wait briefly before forcing a restart.
      clearTimer();
      disconnectTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected') {
          onFailed?.();
        }
      }, 3000);
    }
  };

  pc.addEventListener('connectionstatechange', evaluate);
  pc.addEventListener('iceconnectionstatechange', evaluate);

  return () => {
    clearTimer();
    pc.removeEventListener('connectionstatechange', evaluate);
    pc.removeEventListener('iceconnectionstatechange', evaluate);
  };
}

/** Human-friendly label for a connection state. */
export function stateLabel(state) {
  switch (state) {
    case 'connected':
    case 'completed': return 'Connected';
    case 'connecting':
    case 'checking': return 'Connecting…';
    case 'disconnected': return 'Reconnecting…';
    case 'failed': return 'Reconnecting…';
    case 'closed': return 'Closed';
    default: return 'Starting…';
  }
}

/** mm:ss / h:mm:ss timer formatting. */
export function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
