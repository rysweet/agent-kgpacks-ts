import { defineConfig } from 'vitest/config';

// Per-package Vitest config for @kgpacks/query.
//
// The vector and hybrid retrieval tests build a tiny in-memory LadybugDB fixture
// and embed text with the REAL BGE model via @kgpacks/embeddings. On a cold cache
// the first embed call downloads the ONNX model weights from the HF Hub and
// initializes the ONNX runtime — far beyond Vitest's default 5s test / 10s hook
// timeouts. Both timeouts are raised so the cold-cache download (in `beforeAll`)
// and inference (inside `it(...)`) have room. CI has network access by design
// (fail-closed). The cypher-safety suite is pure and unaffected.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
