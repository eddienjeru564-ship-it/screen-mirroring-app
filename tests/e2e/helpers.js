// Shared e2e helpers: open a host and a viewer in separate browser contexts.

import { expect } from '@playwright/test';

export const MAIN = 'http://localhost:3100';
export const SHORT_EXPIRY = 'http://localhost:3101';
export const STRICT_RATE = 'http://localhost:3102';

/** Fail the test on any console error or uncaught exception in the page. */
export function trackErrors(page, label) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return errors;
}

/** Start a host session (test canvas source). Returns { page, code, errors }. */
export async function startHost(browser, base = MAIN, { password = '', quality } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = trackErrors(page, 'host');
  await page.goto(`${base}/host?test=1`);
  if (quality) await page.selectOption('#quality', quality);
  if (password) await page.fill('#password', password);
  await page.click('#startBtn');
  await expect(page.locator('#code')).toHaveText(/^\d{3}-\d{3}$/);
  const code = await page.locator('#code').textContent();
  return { page, ctx, code, errors };
}

/** Open the viewer page and submit a code. Does not wait for video. */
export async function openViewer(browser, base = MAIN, code, { password } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = trackErrors(page, 'viewer');
  await page.goto(`${base}/view?test=1`);
  await page.fill('#codeInput', code.replace(/\D/g, ''));
  if (password != null) {
    await page.evaluate(() => document.getElementById('pwField').classList.remove('hidden'));
    await page.fill('#pwInput', password);
  }
  await page.click('#joinBtn');
  return { page, ctx, errors };
}

export const framesDecoded = (page) => page.evaluate(() => window.screenview.framesDecoded);

/** Wait until the viewer is showing live video with advancing frames. */
export async function expectLiveVideo(page) {
  await expect.poll(() => page.evaluate(() => window.screenview.videoWidth), {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  const before = await framesDecoded(page);
  await expect.poll(() => framesDecoded(page), { timeout: 10_000 }).toBeGreaterThan(before + 5);
}
