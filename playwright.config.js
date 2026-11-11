// Playwright config — spins up dedicated ScreenView servers for the e2e suite.
//
// Four servers, each with settings a group of tests needs (ports shift with
// E2E_PORT_BASE, default 3100):
//   3100  main suite (1 viewer max, admin password set, lenient rate limit)
//   3101  short code expiry (1.5 s) for the "expired code" test
//   3102  strict rate limit (3 failures/min) for the brute-force test
//   3103  short host grace period (2 s) for the "host vanishes" test
// Logs go to test-results/ so the real logs/sessions.jsonl stays clean.

import { defineConfig } from '@playwright/test';

const BASE_PORT = Number(process.env.E2E_PORT_BASE || 3100);

const common = {
  ADMIN_PASSWORD: 'test-admin',
  MAX_VIEWERS: '1',
  GRACE_MS: '60000',
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
  ],
});
