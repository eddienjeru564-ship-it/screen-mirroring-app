// host.js — host side: capture screen, hand out a code, offer to each viewer.
//
// The host is the sole offerer. Each viewer gets its own RTCPeerConnection with
// the screen tracks added sendonly. ICE restarts are host-initiated on failure.

import { fetchIceConfig, applyQuality, monitorConnection, formatElapsed } from './rtc.js';
import { toast } from './app.js';

const $ = (id) => document.getElementById(id);
const socket = io({ reconnection: true, reconnectionDelayMax: 5000 });

const state = {
  sessionId: null,
  hostToken: null,
  stream: null,
  quality: 'medium',
  iceServers: [],
  startedAt: 0,
  /** @type {Map<string, {pc: RTCPeerConnection, cleanup: Function}>} */
  peers: new Map(),
  ended: false,
};

// Expose a tiny read-only surface for e2e tests / debugging status.
window.screenview = {
  role: 'host',
  get peerCount() { return state.peers.size; },
  get sessionId() { return state.sessionId; },
  get sharing() { return !!state.stream; },
};

// Test-only hooks (?test=1) used by the e2e reconnect tests. Not reachable in
// normal use.
if (new URLSearchParams(location.search).get('test') === '1') {
  window.screenview.dropSignaling = () => socket.io.engine.close();
  window.screenview.forceIceRestart = () => {
    for (const { pc } of state.peers.values()) pc.restartIce();
  };
}

// ---------- Capture ----------
async function getScreenStream() {
  const params = new URLSearchParams(location.search);
  if (params.get('test') === '1') {
    // Test-only deterministic source: an animated canvas. Documented in TESTING.md.
    return makeTestStream();
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false,
  });
}

function makeTestStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let f = 0;
  const draw = () => {
    f++;
    ctx.fillStyle = `hsl(${(f * 2) % 360} 60% 20%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 72px monospace';
    ctx.fillText('ScreenView TEST ' + f, 60, 360);
    ctx.fillRect((f * 7) % canvas.width, 600, 80, 80);
  };
  draw();
  const stream = canvas.captureStream(30);
  const iv = setInterval(draw, 1000 / 30);
  stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(iv));
  stream._testInterval = iv;
  return stream;
}

// ---------- Start ----------
$('startBtn').addEventListener('click', async () => {
  $('setupError').classList.add('hidden');
  $('startBtn').disabled = true;
  state.quality = $('quality').value;
  const password = $('password').value.trim();

  try {
    state.stream = await getScreenStream();
  } catch (err) {
    $('startBtn').disabled = false;
    $('setupError').textContent =
      err?.name === 'NotAllowedError'
        ? 'Screen sharing was cancelled or blocked. Click “Start sharing” to try again.'
        : 'Could not start screen capture: ' + (err?.message || err);
    $('setupError').classList.remove('hidden');
    return;
  }

  const ice = await fetchIceConfig();
  state.iceServers = ice.iceServers;

  // The host stopping the share from the browser UI ends the session cleanly.
  state.stream.getVideoTracks()[0].addEventListener('ended', () => {
    endSession('host_stopped_sharing');
  });

  socket.emit('host:create', { quality: state.quality, password: password || null }, (res) => {
    if (!res?.ok) {
      $('setupError').textContent = 'Server rejected the session. Please retry.';
      $('setupError').classList.remove('hidden');
      $('startBtn').disabled = false;
      return;
    }
    state.sessionId = res.sessionId;
    state.hostToken = res.hostToken;
    showLive(res.codePretty, !!res.hasPassword);
  });
});

function showLive(codePretty, hasPassword) {
  showInviteLink(codePretty.replace(/\D/g, ''));
  $('setup').classList.add('hidden');
  $('ended').classList.add('hidden');
  $('live').classList.remove('hidden');
  $('code').textContent = codePretty;
  $('preview').srcObject = state.stream;
  $('liveQuality').value = state.quality;
  if (hasPassword) $('pwNote').classList.remove('hidden');
  state.startedAt = Date.now();
  tickTimer();
}

// ---------- Per-viewer peer connections ----------
function makePeer(viewerId) {
  // Replace any stale connection for this viewer.
  closePeer(viewerId);

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const entry = { pc, cleanup: null };
  state.peers.set(viewerId, entry);

  for (const track of state.stream.getTracks()) {
    pc.addTrack(track, state.stream);
  }
  // Apply the chosen quality to the video sender.
  const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  applyQuality(videoSender, state.quality);

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) sendSignal(viewerId, { candidate: e.candidate });
  });

  pc.addEventListener('negotiationneeded', async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(viewerId, { description: pc.localDescription });
    } catch (err) {
      console.warn('offer failed for', viewerId, err?.message);
    }
  });

  entry.cleanup = monitorConnection(pc, {
    onState: updateConnBadge,
    onFailed: () => {
      // Host-initiated ICE restart; fires negotiationneeded -> fresh offer.
      if (pc.connectionState !== 'closed') {
        try { pc.restartIce(); } catch { /* older browsers */ }
      }
    },
  });

  return entry;
}

function closePeer(viewerId) {
  const entry = state.peers.get(viewerId);
  if (!entry) return;
  entry.cleanup?.();
  try { entry.pc.close(); } catch { /* ignore */ }
  state.peers.delete(viewerId);
}

function sendSignal(viewerId, data) {
  socket.emit('signal', { to: viewerId, data });
}

// ---------- Signaling from server ----------
socket.on('viewer:joined', ({ viewerId }) => {
  if (!state.stream || state.ended) return;
  makePeer(viewerId); // addTrack triggers negotiationneeded -> offer
  toast('A viewer is now watching.', 'ok');
});

socket.on('viewer:left', ({ viewerId }) => {
  closePeer(viewerId);
  if (!state.ended) toast('A viewer disconnected.', 'warn');
});

socket.on('signal', async ({ from, data }) => {
  if (from?.role !== 'viewer') return;
  const entry = state.peers.get(from.viewerId);
  if (!entry) return;
  const { pc } = entry;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description); // viewer's answer
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.warn('host signal apply failed:', err?.message);
  }
});

socket.on('session:viewers', ({ count }) => {
  $('viewerCount').textContent = String(count);
  if (count > 0) setConn('ok', count === 1 ? '1 viewer connected' : `${count} viewers connected`);
  else setConn('', 'Waiting for viewer…');
});

socket.on('session:ended', ({ reason }) => showEnded(reason));

// Reconnect: Socket.io reconnected us with a new socket id. Re-announce.
socket.on('connect', () => {
  if (state.sessionId && state.hostToken && state.stream && !state.ended) {
    socket.emit('host:rejoin', { sessionId: state.sessionId, hostToken: state.hostToken }, (res) => {
      if (res?.ok) {
        // Re-offer to every viewer the server still knows about.
        for (const viewerId of res.viewers || []) makePeer(viewerId);
      } else {
        showEnded('expired');
      }
    });
  }
});

// ---------- Controls ----------
/**
 * Build a link the viewer can open directly. When the host is on localhost
 * (the usual setup), use the server's LAN address instead — a "localhost"
 * link would point at the viewer's own machine.
 */
const inviteOrigin = (async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return location.origin;
  try {
    const { lanUrls } = await (await fetch('/api/info')).json();
    return lanUrls?.[0] || location.origin;
  } catch {
    return location.origin;
  }
})(); // started at page load, so it is ready by the time a code exists

async function showInviteLink(code) {
  $('inviteLink').value = `${await inviteOrigin}/view?code=${code}`;
}

async function copyText(text, button, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.', 'ok');
  } catch {
    toast('Copy failed — select the text and copy it manually.', 'warn');
    return;
  }
  button.textContent = 'Copied ✓';
  setTimeout(() => (button.textContent = label), 1500);
}

$('copyBtn').addEventListener('click', () => copyText($('code').textContent, $('copyBtn'), 'Copy code'));
$('copyLinkBtn').addEventListener('click', () => copyText($('inviteLink').value, $('copyLinkBtn'), 'Copy link'));
$('inviteLink').addEventListener('focus', (e) => e.target.select());

// Closing or reloading the tab ends the share, so ask first.
window.addEventListener('beforeunload', (e) => {
  if (state.stream && !state.ended) e.preventDefault();
});

$('liveQuality').addEventListener('change', () => {
  state.quality = $('liveQuality').value;
  socket.emit('host:quality', { quality: state.quality });
  for (const { pc } of state.peers.values()) {
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    applyQuality(s, state.quality);
  }
});

$('endBtn').addEventListener('click', () => endSession('host_ended'));

function endSession(reason) {
  if (state.ended) return;
  socket.emit('host:end', {}, () => {});
  showEnded(reason);
}

function showEnded(reason) {
  if (state.ended) return;
  state.ended = true;
  for (const id of [...state.peers.keys()]) closePeer(id);
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    if (state.stream._testInterval) clearInterval(state.stream._testInterval);
  }
  state.stream = null;
  $('live').classList.add('hidden');
  $('setup').classList.add('hidden');
  $('ended').classList.remove('hidden');
  $('endedReason').textContent = endedReasonText(reason);
}

function endedReasonText(reason) {
  switch (reason) {
    case 'host_ended': return 'You ended the session. The join code is no longer valid.';
    case 'host_stopped_sharing': return 'You stopped sharing from your browser. The session is closed.';
    case 'expired': return 'The session expired. Start a new one to share again.';
    case 'host_timeout': return 'The connection was lost for too long and the session timed out.';
    default: return 'The session has ended.';
  }
}

// ---------- Badges & timer ----------
function setConn(kind, text) {
  const badge = $('connBadge');
  badge.className = 'badge' + (kind ? ' ' + kind : '');
  $('connText').textContent = text;
}
function updateConnBadge(connState) {
  // Only downgrade the badge if we actually have viewers.
  if (state.peers.size === 0) return;
  if (connState === 'failed' || connState === 'disconnected') setConn('warn', 'Reconnecting…');
  else if (connState === 'connected' || connState === 'completed')
    setConn('ok', $('viewerCount').textContent + ' connected');
}

function tickTimer() {
  if (state.ended) return;
  $('timer').textContent = formatElapsed(Date.now() - state.startedAt);
  setTimeout(tickTimer, 1000);
}
