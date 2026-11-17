// Soak test: one host + one viewer for SOAK_MINUTES (default 5), checking every
// 30 s that frames are still advancing. Run the long version with:
//   SOAK_MINUTES=120 npm run test:soak
// SOAK_TARGET=vercel runs it against the Vercel-mode server (Upstash store over
// HTTP), so every poll and signaling message goes through Redis REST calls.
//
// Prints a JSON summary line (frames, reconnects, memory) for docs/TESTING.md.

import { test, expect } from '@playwright/test';
import { MAIN, VERCEL_MODE, startHost, openViewer, expectLiveVideo, framesDecoded } from './helpers.js';

const MINUTES = Number(process.env.SOAK_MINUTES || 5);
const CHECK_EVERY_MS = 30_000;
const BASE = process.env.SOAK_TARGET === 'vercel' ? VERCEL_MODE : MAIN;

test(`soak: stream stays live for ${MINUTES} minute(s)`, async ({ browser }) => {
  test.setTimeout(MINUTES * 60_000 + 120_000);

  const host = await startHost(browser, BASE);
  const viewer = await openViewer(browser, BASE, host.code);
  await expectLiveVideo(viewer.page);

  const startedAt = Date.now();
  const startOffers = await viewer.page.evaluate(() => window.screenview.offersReceived);
  let lastFrames = await framesDecoded(viewer.page);
  let checks = 0;
  let stalls = 0;
  const heap = () => viewer.page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  const heapStart = await heap();

  while (Date.now() - startedAt < MINUTES * 60_000) {
    await viewer.page.waitForTimeout(CHECK_EVERY_MS);
    const frames = await framesDecoded(viewer.page);
    checks++;
    if (frames <= lastFrames) stalls++;
    expect(frames, `frames stalled at check ${checks}`).toBeGreaterThan(lastFrames);
    lastFrames = frames;
  }

  const summary = {
    minutes: MINUTES,
    target: process.env.SOAK_TARGET === 'vercel' ? 'vercel-mode (Redis REST store)' : 'local (memory store)',
    checks,
    stalls,
    framesDecoded: lastFrames,
    avgFps: +(lastFrames / ((Date.now() - startedAt) / 1000)).toFixed(1),
    renegotiations: (await viewer.page.evaluate(() => window.screenview.offersReceived)) - startOffers,
    viewerHeapStartMB: heapStart && +(heapStart / 1e6).toFixed(1),
    viewerHeapEndMB: (await heap()) && +((await heap()) / 1e6).toFixed(1),
    consoleErrors: host.errors.length + viewer.errors.length,
  };
  console.log('SOAK_RESULT ' + JSON.stringify(summary));
  expect(summary.consoleErrors).toBe(0);
});
