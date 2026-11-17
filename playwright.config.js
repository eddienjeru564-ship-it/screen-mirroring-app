// Playwright config — spins up dedicated ScreenView servers for the e2e suite.
//
// Four servers, each with settings a group of tests needs (ports shift with
// E2E_PORT_BASE, default 3100):
//   3100  main suite (1 viewer max, admin password set, lenient rate limit)
//   3101  short code expiry (1.5 s) for the "expired code" test
//   3102  strict rate limit (3 failures/min) for the brute-force test
//   3103  short host grace period (2 s) for the "host vanishes" test
//   3104  "Vercel mode": VERCEL=1 with an Upstash store (a fake Upstash API on
//         3110), so sessions, signaling and the log all go through Redis calls
//   3105  "Vercel mode" with no store configured, to check the clear error
// Logs go to test-results/ so the real logs/sessions.jsonl stays clean.

import { defineConfig } from '@playwright/test';

const BASE_PORT = Number(process.env.E2E_PORT_BASE || 3100);

const common = {
  ADMIN_PASSWORD: 'test-admin',
  MAX_VIEWERS: '1',
  GRACE_MS: '60000',
  // A viewer silent for 3 s counts as gone (default 12 s), so the
  // reconnect test doesn't have to wait long.
  VIEWER_STALE_MS: '3000',
};

function server(port, extraEnv) {
  return {
    command: 'node server/index.js',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      ...common,
      PORT: String(port),
      LOG_FILE: `test-results/sessions-${port}.jsonl`,
      RATE_LIMIT_MAX: '1000',
      ...extraEnv,
    },
  };
}

export default defineConfig({
  testDir: 'tests/e2e',
  // The soak test only runs via `npm run test:soak` (see package.json).
  testIgnore: process.env.SOAK ? [] : ['**/soak.spec.js'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    trace: 'off',
    launchOptions: {
      // Use a pre-installed Chromium when one is provided (e.g. CI images).
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        // Expose real host candidates instead of mDNS names so two headless
        // pages on one machine can always connect without STUN.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    server(BASE_PORT),
    server(BASE_PORT + 1, { CODE_EXPIRY_MS: '1500' }),
    server(BASE_PORT + 2, { RATE_LIMIT_MAX: '3' }),
    server(BASE_PORT + 3, { GRACE_MS: '2000' }),
    {
      command: `node tests/e2e/fakeUpstashServer.js ${BASE_PORT + 10}`,
      url: `http://localhost:${BASE_PORT + 10}/`,
      reuseExistingServer: false,
    },
    server(BASE_PORT + 4, {
      VERCEL: '1',
      KV_REST_API_URL: `http://localhost:${BASE_PORT + 10}`,
      KV_REST_API_TOKEN: 'test-token',
    }),
    server(BASE_PORT + 5, { VERCEL: '1' }),
  ],
});
