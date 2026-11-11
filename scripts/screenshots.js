// Regenerates the documentation screenshots in docs/img/.
// Usage: npm run screenshots   (needs Playwright's Chromium installed)
//
// Starts its own server on port 3200 and drives a host + viewer session with
// the ?test=1 canvas source, so the images are reproducible.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const OUT = 'docs/img';

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'demo', LOG_FILE: 'test-results/screenshots.jsonl' },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

try {
  await waitForServer();
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'],
  });
  const opts = { viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' };
  const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

  const landing = await (await browser.newContext(opts)).newPage();
  await landing.goto(BASE);
  await shot(landing, 'landing');

  const host = await (await browser.newContext(opts)).newPage();
  await host.goto(`${BASE}/host?test=1`);
  await shot(host, 'host-setup');
  await host.click('#startBtn');
  const code = (await host.locator('#code').textContent()).trim();

  const viewer = await (await browser.newContext(opts)).newPage();
  await viewer.goto(`${BASE}/view?test=1`);
  await viewer.locator('#codeInput').pressSequentially(code.replace('-', ''));
  await shot(viewer, 'viewer-enter-code');
  await viewer.click('#joinBtn');
  await viewer.waitForFunction(() => window.screenview.framesDecoded > 30);
  await host.locator('#viewerCount', { hasText: '1' }).waitFor();
  await host.waitForTimeout(1500);
  await shot(host, 'host-live');
  await shot(viewer, 'viewer-watching');

  const bad = await (await browser.newContext(opts)).newPage();
  await bad.goto(`${BASE}/view`);
  await bad.locator('#codeInput').pressSequentially('000000');
  await bad.click('#joinBtn');
  await bad.locator('#entryError:not(.hidden)').waitFor();
  await shot(bad, 'viewer-error');

  await host.click('#endBtn');
  await viewer.locator('#gone:not(.hidden)').waitFor();
  await shot(viewer, 'viewer-ended');

  const admin = await (await browser.newContext(opts)).newPage();
  await admin.goto(`${BASE}/admin`);
  await admin.fill('#adminPw', 'demo');
  await admin.click('#loginBtn');
  await admin.locator('#rows tr').first().waitFor();
  await shot(admin, 'admin');

  await browser.close();
  console.log(`Screenshots written to ${OUT}/`);
} finally {
  server.kill();
}
