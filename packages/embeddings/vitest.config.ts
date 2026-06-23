import { defineConfig } from 'vitest/config';

// Per-package Vitest config for @kgpacks/embeddings.
//
// The parity gate (test/parity.test.ts) calls the real Transformers.js
// feature-extraction pipeline. On a cold cache its FIRST run downloads the ONNX
// model weights from the HF Hub and initializes the ONNX runtime before any
// inference — far beyond Vitest's default 5s test / 10s hook timeouts.
//
// Because the model is loaded in a `beforeAll` hook, BOTH timeouts must be
// raised: `testTimeout` covers inference inside `it(...)`, and `hookTimeout`
// covers the cold-cache download + warm-up inside `beforeAll(...)`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
