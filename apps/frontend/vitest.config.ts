import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config for the offline (jsdom) unit suite.
//
// Runs only `src/**/*.test.{ts,tsx}` — the Playwright smoke under `e2e/` is opt-in
// (`pnpm test:e2e`) and deliberately excluded here so `pnpm -r test` stays fast and
// offline. See docs/packages/frontend.md#testing-strategy.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
});
