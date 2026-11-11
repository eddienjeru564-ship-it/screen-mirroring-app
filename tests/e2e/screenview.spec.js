// End-to-end tests for the full host -> server -> viewer flow.

import { test, expect } from '@playwright/test';
import {
  MAIN, SHORT_EXPIRY, STRICT_RATE,
  startHost, openViewer, expectLiveVideo, framesDecoded,
} from './helpers.js';

test('host shares, viewer joins and receives live, advancing frames', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);

  await expectLiveVideo(viewer.page);
  await expect(viewer.page.locator('#statusText')).toHaveText('Connected');
  await expect(host.page.locator('#viewerCount')).toHaveText('1');
  await expect(host.page.locator('#timer')).not.toHaveText('00:00', { timeout: 5000 });

  // A normal session produces no console errors on either side.
  expect([...host.errors, ...viewer.errors]).toEqual([]);
});

test('invalid code shows an error', async ({ browser }) => {
  const viewer = await openViewer(browser, MAIN, '000000');
  await expect(viewer.page.locator('#entryError')).toContainText('isn’t valid');
});

test('code input auto-formats as NNN-NNN', async ({ page }) => {
  await page.goto(`${MAIN}/view`);
  await page.locator('#codeInput').pressSequentially('482913');
  await expect(page.locator('#codeInput')).toHaveValue('482-913');
});

test('expired code shows an error', async ({ browser }) => {
  const host = await startHost(browser, SHORT_EXPIRY);
  await host.page.waitForTimeout(2000); // server CODE_EXPIRY_MS is 1.5 s
  const viewer = await openViewer(browser, SHORT_EXPIRY, host.code);
  await expect(viewer.page.locator('#entryError')).toContainText('expired');
});

test('second viewer gets "session full"', async ({ browser }) => {
  const host = await startHost(browser);
  const first = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(first.page);
  const second = await openViewer(browser, MAIN, host.code);
  await expect(second.page.locator('#entryError')).toContainText('full');
});

test('host ending the session tells the viewer', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);

  await host.page.click('#endBtn');
  await expect(host.page.locator('#ended')).toBeVisible();
  await expect(viewer.page.locator('#goneTitle')).toHaveText('Session ended');
  await expect(viewer.page.locator('#goneReason')).toContainText('host ended');

  // The code is dead forever afterwards.
  const late = await openViewer(browser, MAIN, host.code);
  await expect(late.page.locator('#entryError')).toBeVisible();
});

test('host stopping the capture track ends the session', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);

  // Same path as the user clicking the browser's "Stop sharing" button.
  await host.page.evaluate(() => {
    const t = document.getElementById('preview').srcObject.getVideoTracks()[0];
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });
  await expect(viewer.page.locator('#goneTitle')).toHaveText('Session ended');
});

test('stream resumes after a signaling drop on both sides, no code re-entry', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);
  const offersBefore = await viewer.page.evaluate(() => window.screenview.offersReceived);

  // Kill both Socket.io transports; they auto-reconnect and rejoin.
  await viewer.page.evaluate(() => window.screenview.dropSignaling());
  await host.page.evaluate(() => window.screenview.dropSignaling());

  await expect.poll(() => viewer.page.evaluate(() => window.screenview.offersReceived), {
    timeout: 20_000,
  }).toBeGreaterThan(offersBefore);
  await expectLiveVideo(viewer.page);
  await expect(viewer.page.locator('#watch')).toBeVisible(); // never sent back to code entry
  await expect(host.page.locator('#viewerCount')).toHaveText('1');
});

test('stream survives an ICE restart', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);
  const offersBefore = await viewer.page.evaluate(() => window.screenview.offersReceived);

  await host.page.evaluate(() => window.screenview.forceIceRestart());

  await expect.poll(() => viewer.page.evaluate(() => window.screenview.offersReceived), {
    timeout: 10_000,
  }).toBeGreaterThan(offersBefore);
  const sdp = await viewer.page.evaluate(() => window.screenview.connectionState);
  expect(['connected', 'connecting']).toContain(sdp);
  const f = await framesDecoded(viewer.page);
  await expect.poll(() => framesDecoded(viewer.page), { timeout: 10_000 }).toBeGreaterThan(f + 5);
});

test('viewer is view-only: no data channels and no outgoing tracks', async ({ browser }) => {
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);

  const v = await viewer.page.evaluate(() => ({
    dc: window.screenview.dataChannelCount,
    out: window.screenview.outgoingTrackCount,
  }));
  expect(v).toEqual({ dc: 0, out: 0 });

  // The viewer's negotiated answer has no data-channel (m=application) section,
  // and every media section is receive-only.
  const sdp = await viewer.page.evaluate(() => window.screenview.localSdp);
  expect(sdp).not.toContain('m=application');
  const mediaSections = sdp.split(/\r?\nm=/).slice(1);
  expect(mediaSections.length).toBeGreaterThan(0);
  for (const section of mediaSections) {
    expect(section).toMatch(/a=recvonly|a=inactive/);
    expect(section).not.toMatch(/a=(sendrecv|sendonly)/);
  }
});

test('password-protected session requires the password', async ({ browser }) => {
  const host = await startHost(browser, MAIN, { password: 'open-sesame' });
  const noPw = await openViewer(browser, MAIN, host.code);
  await expect(noPw.page.locator('#entryError')).toContainText('password');
  await expect(noPw.page.locator('#pwField')).toBeVisible();

  const wrong = await openViewer(browser, MAIN, host.code, { password: 'nope' });
  await expect(wrong.page.locator('#entryError')).toContainText('password');

  const right = await openViewer(browser, MAIN, host.code, { password: 'open-sesame' });
  await expectLiveVideo(right.page);
});

test('too many wrong codes are rate limited', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${STRICT_RATE}/view`);
  for (let i = 0; i < 3; i++) {
    await page.fill('#codeInput', '000000');
    await page.click('#joinBtn');
    await expect(page.locator('#entryError')).toContainText('isn’t valid');
    await page.evaluate(() => document.getElementById('entryError').classList.add('hidden'));
  }
  await page.fill('#codeInput', '000000');
  await page.click('#joinBtn');
  await expect(page.locator('#entryError')).toContainText('Too many attempts');
});

test('admin rejects a wrong password and lists sessions with the right one', async ({ browser }) => {
  // Create a session with one viewer, then end it, so the log has a full record.
  const host = await startHost(browser);
  const viewer = await openViewer(browser, MAIN, host.code);
  await expectLiveVideo(viewer.page);
  await host.page.click('#endBtn');
  await expect(viewer.page.locator('#gone')).toBeVisible();

  const page = await browser.newPage();
  await page.goto(`${MAIN}/admin`);
  await page.fill('#adminPw', 'wrong');
  await page.click('#loginBtn');
  await expect(page.locator('#loginError')).toContainText('Wrong password');
  await expect(page.locator('#dash')).toBeHidden();

  await page.fill('#adminPw', 'test-admin');
  await page.click('#loginBtn');
  await expect(page.locator('#dash')).toBeVisible();
  const row = page.locator('#rows tr', { hasText: host.code });
  await expect(row).toBeVisible();
  await expect(row).toContainText('host_ended');
  await expect(row).toContainText('1 / 1'); // the viewer's join AND leave were logged
});

test('host vanishing ends the session after the grace period', async ({ browser }) => {
  const host = await startHost(browser, SHORT_EXPIRY);
  const viewer = await openViewer(browser, SHORT_EXPIRY, host.code);
  await expectLiveVideo(viewer.page);

  await host.ctx.close(); // host's tab is gone: no clean "end", just a disconnect
  // Server GRACE_MS is 2 s and sweeps every 5 s.
  await expect(viewer.page.locator('#goneTitle')).toHaveText('Host disconnected', { timeout: 15_000 });
});
