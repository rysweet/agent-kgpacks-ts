import { defineConfig } from 'vitest/config';

// Per-package Vitest config for @kgpacks/ingestion.
//
// The loader round-trip suite builds a tiny in-memory LadybugDB and creates a
// real cosine HNSW vector index over the loaded Section embeddings, then queries
// it back via QUERY_VECTOR_INDEX. Loading the VECTOR extension may fetch it over
// HTTPS the first time (fail-closed; CI has network), which can exceed Vitest's
// default 5s test / 10s hook timeouts. Both are raised. All HTTP and LLM calls in
// every suite are mocked via injected seams, so no test needs real network for
// fetching or the model — only the VECTOR extension load.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
