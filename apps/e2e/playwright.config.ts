import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against a running stack (`docker compose up -d`), through nginx, exactly
 * as a user reaches it. Nothing is mocked: the API, worker, database, Redis, Socket.IO and a real
 * upstream API all take part.
 *
 * - E2E_BASE_URL: the app (default http://localhost:8080).
 * - E2E_UPSTREAM_URL: an API with /status/<code> routes to monitor (default https://httpbin.org).
 * - E2E_BROWSER_CHANNEL: an installed browser to drive. On Windows it defaults to Microsoft Edge,
 *   which ships with the OS, so no browser download is needed. Elsewhere (and in CI) Playwright's
 *   own Chromium is used: install it once with `pnpm exec playwright install chromium`.
 */
const channel =
  process.env.E2E_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);

export default defineConfig({
  testDir: './tests',
  // The critical flow waits for real monitor checks; one test is long by nature.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  // A real upstream API can hiccup; retry once in CI, never locally (to see failures plainly).
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    ...(channel ? { channel } : {}),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
