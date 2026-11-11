// Unit tests for the connection-health monitor that triggers ICE restarts.
// public/rtc.js uses only standard APIs, so it runs in Node with a fake
// RTCPeerConnection built on EventTarget.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { monitorConnection, formatElapsed, stateLabel } from '../../public/rtc.js';

class FakePC extends EventTarget {
  connectionState = 'new';
  iceConnectionState = 'new';
  set(state) {
    this.connectionState = state;
    this.iceConnectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

test('failed triggers a restart immediately', () => {
  const pc = new FakePC();
  let restarts = 0;
  monitorConnection(pc, { onFailed: () => restarts++ });
  pc.set('failed');
  assert.equal(restarts, 1);
});

test('disconnected triggers a restart only if it lasts 3 s', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pc = new FakePC();
    let restarts = 0;
    monitorConnection(pc, { onFailed: () => restarts++ });

    // A transient blip that recovers: no restart.
    pc.set('disconnected');
    mock.timers.tick(2000);
    pc.set('connected');
    mock.timers.tick(5000);
    assert.equal(restarts, 0);

    // A disconnect that persists: restart after 3 s.
    pc.set('disconnected');
    mock.timers.tick(2999);
    assert.equal(restarts, 0);
    mock.timers.tick(1);
    assert.equal(restarts, 1);
  } finally {
    mock.timers.reset();
  }
});

test('cleanup stops monitoring', () => {
  const pc = new FakePC();
  let restarts = 0;
  const stop = monitorConnection(pc, { onFailed: () => restarts++ });
  stop();
  pc.set('failed');
  assert.equal(restarts, 0);
});

test('formatElapsed and stateLabel', () => {
  assert.equal(formatElapsed(65_000), '01:05');
  assert.equal(formatElapsed(2 * 3600_000 + 5_000), '2:00:05');
  assert.equal(stateLabel('failed'), 'Reconnecting…');
  assert.equal(stateLabel('connected'), 'Connected');
});
