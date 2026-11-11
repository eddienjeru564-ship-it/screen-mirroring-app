// view.js — viewer side: enter a code, receive the host's screen, watch.
//
// VIEW-ONLY BY DESIGN: the viewer never calls addTrack and never creates a data
// channel, so there is no transport for input to reach the host. The peer
// connection only ever answers the host's offers.

import { fetchIceConfig, monitorConnection, stateLabel } from './rtc.js';

const $ = (id) => document.getElementById(id);
const socket = io({ reconnection: true, reconnectionDelayMax: 5000 });

const state = {
  sessionId: null,
  viewerId: null,
  viewerToken: null,
  iceServers: [],
  pc: null,
  cleanup: null,
  pendingCandidates: [],
  gone: false,
  dataChannelsSeen: 0, // should always stay 0 — asserted by the view-only test
};

// Read-only surface for e2e tests (verifies view-only guarantees).
window.screenview = {
  role: 'viewer',
  get dataChannelCount() { return state.dataChannelsSeen; },
  get outgoingTrackCount() {
    return state.pc ? state.pc.getSenders().filter((s) => s.track).length : 0;
  },
  get connectionState() { return state.pc?.connectionState ?? 'none'; },
  get videoWidth() { return $('video')?.videoWidth ?? 0; },
};

// ---------- Code input auto-formatting (NNN-NNN) ----------
const codeInput = $('codeInput');
codeInput.addEventListener('input', () => {
  const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
  codeInput.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

// ---------- Join ----------
$('joinBtn').addEventListener('click', join);

async function join() {
  const code = codeInput.value.replace(/\D/g, '');
  if (code.length !== 6) return showEntryError('Enter all 6 digits of the code.');
  const password = $('pwInput').value || null;

  $('joinBtn').disabled = true;
  $('entryError').classList.add('hidden');

  const ice = await fetchIceConfig();
  state.iceServers = ice.iceServers;

  socket.emit('viewer:join', { code, password }, async (res) => {
    $('joinBtn').disabled = false;
    if (!res?.ok) return handleJoinError(res?.error, res?.retryAfterMs);

    state.sessionId = res.sessionId;
    state.viewerId = res.viewerId;
    state.viewerToken = res.viewerToken;
    sessionStorage.setItem('sv-viewer', JSON.stringify({
      sessionId: res.sessionId, viewerId: res.viewerId, viewerToken: res.viewerToken,
    }));
    setupPeer();
    showWatch();
  });
}

function handleJoinError(error, retryAfterMs) {
  if (error === 'wrong_password') {
    // Reveal the password field and let them retry.
    $('pwField').classList.remove('hidden');
    return showEntryError('This session needs a password (or the password was wrong).');
  }
  const msg = {
    invalid_code: 'That code isn’t valid. Check the digits and try again.',
    expired: 'That code has expired. Ask the host for a fresh one.',
    ended: 'That session has already ended.',
    session_full: 'This session is full — the maximum number of viewers are already watching.',
    rate_limited: `Too many attempts. Wait ${Math.ceil((retryAfterMs || 60000) / 1000)}s and try again.`,
    not_found: 'That session could not be found.',
  }[error] || 'Could not join the session. Please try again.';
  showEntryError(msg);
}

function showEntryError(msg) {
  $('entryError').textContent = msg;
  $('entryError').classList.remove('hidden');
}

// ---------- Peer (answer-only) ----------
function setupPeer() {
  teardownPeer();
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc;
  state.pendingCandidates = [];

  // If the host ever tried to open a data channel, we'd notice here. It never
  // should — tracked so the view-only test can assert it stays zero.
  pc.addEventListener('datachannel', () => { state.dataChannelsSeen++; });

  pc.addEventListener('track', (e) => {
    const [stream] = e.streams;
    const video = $('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play?.().catch(() => {});
    hideOverlay();
  });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) socket.emit('signal', { to: 'host', data: { candidate: e.candidate } });
  });

  state.cleanup = monitorConnection(pc, {
    onState: (s) => setStatus(s),
    onConnected: hideOverlay,
    onFailed: () => {
      // The host drives ICE restarts; we just surface the reconnecting state.
      showOverlay('Connection interrupted — reconnecting…');
    },
  });
}

function teardownPeer() {
  state.cleanup?.();
  if (state.pc) { try { state.pc.close(); } catch { /* ignore */ } }
  state.pc = null;
}

// ---------- Signaling from server ----------
socket.on('signal', async ({ from, data }) => {
  if (from?.role !== 'host' || !state.pc) return;
  const pc = state.pc;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description); // host's offer (incl. ICE restart)
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: 'host', data: { description: pc.localDescription } });
      // Flush any candidates that arrived before the offer.
      for (const c of state.pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(c); } catch { /* ignore */ }
      }
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(data.candidate);
      else state.pendingCandidates.push(data.candidate);
    }
  } catch (err) {
    console.warn('viewer signal apply failed:', err?.message);
  }
});

socket.on('session:ended', ({ reason }) => showGone(reason));

// Reconnect handling: rejoin with the saved token, then wait for a fresh offer.
socket.on('connect', () => {
  if (state.sessionId && state.viewerToken && !state.gone) {
    showOverlay('Reconnecting…');
    socket.emit('viewer:rejoin', {
      sessionId: state.sessionId, viewerId: state.viewerId, viewerToken: state.viewerToken,
    }, (res) => {
      if (res?.ok) setupPeer(); // host will re-offer
      else showGone('ended');
    });
  }
});

// ---------- UI ----------
function showWatch() {
  $('entry').classList.add('hidden');
  $('watch').classList.remove('hidden');
  showOverlay('Connecting to the shared screen…');
}

function showOverlay(text) {
  $('overlayText').textContent = text;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

function setStatus(connState) {
  const label = stateLabel(connState);
  $('statusText').textContent = label;
  const badge = $('statusBadge');
  if (connState === 'connected' || connState === 'completed') badge.className = 'badge ok';
  else if (connState === 'failed' || connState === 'disconnected') badge.className = 'badge warn';
  else badge.className = 'badge';
}

$('fsBtn').addEventListener('click', () => {
  const stage = $('video').parentElement;
  if (!document.fullscreenElement) stage.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
});

$('leaveBtn').addEventListener('click', () => {
  state.gone = true;
  teardownPeer();
  sessionStorage.removeItem('sv-viewer');
  socket.disconnect();
  showGone('left');
});

function showGone(reason) {
  if (state.gone && reason !== 'left') { /* still show message */ }
  state.gone = true;
  teardownPeer();
  sessionStorage.removeItem('sv-viewer');
  $('watch').classList.add('hidden');
  $('entry').classList.add('hidden');
  $('gone').classList.remove('hidden');
  const map = {
    host_ended: ['Session ended', 'The host ended the session.'],
    host_stopped_sharing: ['Sharing stopped', 'The host stopped sharing their screen.'],
    host_timeout: ['Host disconnected', 'The host lost connection and the session timed out.'],
    expired: ['Session expired', 'This session is no longer available.'],
    ended: ['Session ended', 'This session has ended.'],
    left: ['You left', 'You left the session. Enter a code to watch again.'],
  };
  const [title, text] = map[reason] || ['Session ended', 'This session has ended.'];
  $('goneTitle').textContent = title;
  $('goneReason').textContent = text;
}

// Prefill a code from the URL (?code=482913 or 482-913) for convenience.
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  codeInput.value = urlCode;
  codeInput.dispatchEvent(new Event('input'));
}
