// The deployment configuration used on Vercel: VERCEL=1 plus an Upstash Redis
// store (here a fake Upstash API over HTTP). Every session record, signaling
// message and log line goes through Redis REST calls, exactly as in production.

import { test, expect } from '@playwright/test';
import {
  VERCEL_MODE, VERCEL_NO_STORE, startHost, openViewer, expectLiveVideo,
} from './helpers.js';

test('vercel mode: full session over the Redis store, with a clean console', async ({ browser }) => {
  const health = await (await fetch(`${VERCEL_MODE}/api/health`)).json();
  expect(health).toMatchObject({ ok: true, store: 'upstash', storageConfigured: true });

  const host = await startHost(browser, VERCEL_MODE);
  const viewer = await openViewer(browser, VERCEL_MODE, host.code);
  await expectLiveVideo(viewer.page);
  await expect(host.page.locator('#viewerCount')).toHaveText('1');

  // The invite link uses the site's own address (no LAN lookup on Vercel).
  await expect(host.page.locator('#inviteLink')).toHaveValue(`${VERCEL_MODE}/view?code=${host.code.replace('-', '')}`);

  // Reconnect without the code, through the Redis-backed rejoin path.
  const offers = await viewer.page.evaluate(() => window.screenview.offersReceived);
  await viewer.page.evaluate(() => window.screenview.dropSignaling(4500));
  await expect.poll(() => viewer.page.evaluate(() => window.screenview.offersReceived), {
    timeout: 20_000,
  }).toBeGreaterThan(offers);
  await expectLiveVideo(viewer.page);

  await host.page.click('#endBtn');
  await expect(viewer.page.locator('#goneTitle')).toHaveText('Session ended');
  expect([...host.errors, ...viewer.errors]).toEqual([]);

  // The admin log lives in Redis on Vercel (no disk there).
  const res = await fetch(`${VERCEL_MODE}/api/admin/sessions`, {
    headers: { 'x-admin-password': 'test-admin' },
  });
  const { sessions } = await res.json();
  const row = sessions.find((s) => s.code === host.code.replace('-', ''));
  expect(row).toMatchObject({ endReason: 'host_ended', viewerJoins: 1 });
});

test('vercel mode: session full and expired/ended codes work across requests', async ({ browser }) => {
  const host = await startHost(browser, VERCEL_MODE);
  const first = await openViewer(browser, VERCEL_MODE, host.code);
  await expectLiveVideo(first.page);
  const second = await openViewer(browser, VERCEL_MODE, host.code);
  await expect(second.page.locator('#entryError')).toContainText('full');
  await host.page.click('#endBtn');
  const late = await openViewer(browser, VERCEL_MODE, host.code);
  await expect(late.page.locator('#entryError')).toContainText('already ended');
});

test('vercel mode without storage explains the problem instead of half-working', async ({ browser }) => {
  const health = await (await fetch(`${VERCEL_NO_STORE}/api/health`)).json();
  expect(health.storageConfigured).toBe(false);

  const page = await (await browser.newContext()).newPage();
  await page.goto(`${VERCEL_NO_STORE}/host?test=1`);
  await page.click('#startBtn');
  await expect(page.locator('#setupError')).toContainText('session storage (Redis) is missing');
  await expect(page.locator('#startBtn')).toBeEnabled();
});
