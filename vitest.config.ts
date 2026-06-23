import { defineConfig } from 'vitest/config';

// Root Vitest configuration.
//
// `pnpm -r test` runs each package's own `vitest run` (scoped to that package's
// cwd, so it discovers only that package's `test/**` specs). This root config is
// used by `pnpm test:root`, which runs the repo-level structural suites under
// `test/**` (scaffold + python-free guard contracts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 60_000,
  },
});
