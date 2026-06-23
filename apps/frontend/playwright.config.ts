import { defineConfig, devices } from '@playwright/test';

// Playwright smoke test config (opt-in via `pnpm test:e2e`).
//
// Builds and serves the production bundle, then asserts the app renders. Kept out
// of `pnpm -r test` so the recursive suite never downloads a browser. See
// docs/packages/frontend.md#testing-strategy.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
