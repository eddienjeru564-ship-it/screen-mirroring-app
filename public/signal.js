// signal.js — browser side of signaling over plain HTTPS.
//
// Replaces a WebSocket with two simple things:
//   • call(path, body)      one JSON POST to /api/<path>
//   • a poll loop           asks the server "anything for me?" every ~2 s,
//                           and every 300 ms while a connection is being set up
// Outgoing ICE candidates are batched into one request. Network errors are
// retried quietly: a brief Wi-Fi drop just means a few polls are skipped.

const FAST_MS = 300;
const FAST_WINDOW_MS = 8000;

export async function call(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status}`);
  return json;
}

/**
 * Start polling. `getBody()` supplies the credentials for each poll;
 * `onResult(res)` handles each reply. Returns a controller.
 */
export function createPoller(path, getBody, onResult, { onError } = {}) {
  let running = true;
  let idleMs = 2000;
  let fastUntil = Date.now() + FAST_WINDOW_MS;
  let pausedUntil = 0;
  let wake = null;
  let failures = 0;

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wake = null; resolve(); }
    wake = done;
  });

  (async () => {
    while (running) {
      if (Date.now() < pausedUntil) {
        await sleep(Math.min(200, pausedUntil - Date.now()));
        continue;
      }
      try {
        const res = await call(path, getBody());
        failures = 0;
        if (res.pollMs) idleMs = res.pollMs;
        if (res.events?.length || res.rejoined) fastUntil = Date.now() + FAST_WINDOW_MS;
        if (running) await onResult(res);
      } catch (err) {
        failures++;
        onError?.(err, failures);
      }
      if (!running) break;
      const delay = failures ? Math.min(5000, 500 * 2 ** (failures - 1))
        : Date.now() < fastUntil ? FAST_MS : idleMs;
      await sleep(delay);
    }
  })();

  return {
    /** Poll quickly for a while (e.g. right after sending an offer). */
    boost() {
      fastUntil = Date.now() + FAST_WINDOW_MS;
      wake?.();
    },
    /** Test hook: behave as if the network dropped for `ms`. */
    pause(ms) {
      pausedUntil = Date.now() + ms;
    },
    stop() {
      running = false;
      wake?.();
    },
  };
}

/**
 * Queue outgoing signaling messages and send them in one request per tick,
 * retrying on network errors so nothing is lost during a brief drop.
 */
export function createSender(getAuth, poller) {
  let queue = [];
  let scheduled = false;

  async function flush() {
    scheduled = false;
    if (!queue.length) return;
    const messages = queue;
    queue = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await call('signal', { ...getAuth(), messages });
        poller()?.boost(); // an answer/offer is likely coming back soon
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  return (to, data) => {
    // JSON round-trip turns RTCSessionDescription / RTCIceCandidate into plain objects.
    queue.push({ to, data: JSON.parse(JSON.stringify(data)) });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 30);
    }
  };
}
