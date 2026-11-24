// The deployment configuration used on Vercel: VERCEL=1 plus a shared store,
// either Upstash Redis (a fake Upstash API over HTTP) or Supabase (the real
// SQL function in PGlite behind a fake Supabase API). Every session record,
// signaling message and log line goes through the store's REST calls, exactly
// as in production.

import { test, expect } from '@playwright/test';
import {
  VERCEL_MODE, VERCEL_NO_STORE, VERCEL_SUPABASE, startHost, openViewer, expectLiveVideo,
} from './helpers.js';

for (const [storeKind, BASE] of [['upstash', VERCEL_MODE], ['supabase', VERCEL_SUPABASE]]) {

test(`vercel mode (${storeKind}): full session, rejoin, end and log, with a clean console`, async ({ browser }) => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  expect(health).toMatchObject({ ok: true, store: storeKind, storageConfigured: true });

  const host = await startHost(browser, BASE);
  const viewer = await openViewer(browser, BASE, host.code);
  await expectLiveVideo(viewer.page);
  await expect(host.page.locator('#viewerCount')).toHaveText('1');

  // The invite link uses the site's own address (no LAN lookup on Vercel).
  await expect(host.page.locator('#inviteLink')).toHaveValue(`${BASE}/view?code=${host.code.replace('-', '')}`);

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

  // The admin log lives in the store on Vercel (no disk there). Ending is
  // fire-and-forget from the host, so the session_end log line can land a
  // moment after the UI switches — poll rather than read once.
  const readRow = async () => {
    const res = await fetch(`${BASE}/api/admin/sessions`, { headers: { 'x-admin-password': 'test-admin' } });
    const { sessions } = await res.json();
    return sessions.find((s) => s.code === host.code.replace('-', ''));
  };
  await expect.poll(readRow, { timeout: 10_000 }).toMatchObject({ endReason: 'host_ended', viewerJoins: 1 });
});

test(`vercel mode (${storeKind}): session full and ended codes work across requests`, async ({ browser }) => {
  const host = await startHost(browser, BASE);
  const first = await openViewer(browser, BASE, host.code);
  await expectLiveVideo(first.page);
  const second = await openViewer(browser, BASE, host.code);
  await expect(second.page.locator('#entryError')).toContainText('full');
  await host.page.click('#endBtn');
  const late = await openViewer(browser, BASE, host.code);
  await expect(late.page.locator('#entryError')).toContainText('already ended');
});

}

test('vercel mode without storage explains the problem instead of half-working', async ({ browser }) => {
  const health = await (await fetch(`${VERCEL_NO_STORE}/api/health`)).json();
  expect(health.storageConfigured).toBe(false);

  const page = await (await browser.newContext()).newPage();
  await page.goto(`${VERCEL_NO_STORE}/host?test=1`);
  await page.click('#startBtn');
  await expect(page.locator('#setupError')).toContainText('session storage (Supabase or Redis) is missing');
  await expect(page.locator('#startBtn')).toBeEnabled();
});
