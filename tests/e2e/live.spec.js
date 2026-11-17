// Checks a real deployment end to end (e.g. the Vercel site). Only runs when
// LIVE_URL is set:
//   LIVE_URL=https://screenview-share.vercel.app npm run test:live
// Uses the ?test=1 canvas source, so no real screen is captured.

import { test, expect } from '@playwright/test';
import { startHost, openViewer, expectLiveVideo } from './helpers.js';

const LIVE = (process.env.LIVE_URL || '').replace(/\/+$/, '');

test('live: storage is configured', async ({ page }) => {
  await page.goto(`${LIVE}/api/health`);
  const health = JSON.parse(await page.locator('body').innerText());
  expect(health).toMatchObject({ ok: true, storageConfigured: true });
});

test('live: every page loads with no console errors or failed requests', async ({ browser }) => {
  for (const path of ['/', '/host', '/view', '/admin']) {
    const page = await browser.newPage();
    const problems = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${path}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`${path}: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`${path}: failed ${r.url()}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`${path}: HTTP ${r.status()} ${r.url()}`); });
    await page.goto(LIVE + path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  }
});

test('live: host → code → viewer sees live video; drop + rejoin; end', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await startHost(browser, LIVE);
  await expect(host.page.locator('#inviteLink')).toHaveValue(`${LIVE}/view?code=${host.code.replace('-', '')}`);
  const joinStart = Date.now();
  const viewer = await openViewer(browser, LIVE, host.code);
  await expectLiveVideo(viewer.page);
  console.log(`LIVE join-to-video: ${Date.now() - joinStart} ms`);
  await expect(host.page.locator('#viewerCount')).toHaveText('1');
  await expect(viewer.page.locator('#statusText')).toHaveText('Connected');

  // Signaling outage longer than VIEWER_STALE_MS (12 s): the viewer is counted
  // as gone, then re-admitted by token, and the host re-offers. No code re-entry.
  const offers = await viewer.page.evaluate(() => window.screenview.offersReceived);
  await viewer.page.evaluate(() => window.screenview.dropSignaling(14_000));
  await expect.poll(() => viewer.page.evaluate(() => window.screenview.offersReceived), {
    timeout: 40_000,
  }).toBeGreaterThan(offers);
  await expectLiveVideo(viewer.page);
  await expect(viewer.page.locator('#watch')).toBeVisible();

  // A second viewer is refused (MAX_VIEWERS=1).
  const second = await openViewer(browser, LIVE, host.code);
  await expect(second.page.locator('#entryError')).toContainText('full');

  await host.page.click('#endBtn');
  await expect(viewer.page.locator('#goneTitle')).toHaveText('Session ended');
  const late = await openViewer(browser, LIVE, host.code);
  await expect(late.page.locator('#entryError')).toContainText('already ended');

  expect([...host.errors, ...viewer.errors]).toEqual([]);
});

test('live: wrong code is rejected cleanly', async ({ browser }) => {
  const viewer = await openViewer(browser, LIVE, '000000');
  await expect(viewer.page.locator('#entryError')).toContainText('isn’t valid');
  expect(viewer.errors).toEqual([]);
});
