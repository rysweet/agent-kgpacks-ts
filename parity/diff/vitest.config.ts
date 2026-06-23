import { defineConfig } from 'vitest/config';

// Per-package Vitest config for @kgpacks/parity.
//
// The parity diff suite is pure and in-process — it loads a tiny committed JSON
// fixture and compares synthetic pipeline outputs against it. No network, no
// model downloads, so the default timeouts are fine; we only scope discovery to
// this package's own `test/**` specs.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
