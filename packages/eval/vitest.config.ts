import { defineConfig } from 'vitest/config';

// Per-package Vitest config for @kgpacks/eval.
//
// Every external seam (judge transport, synthesis agent, retriever, question
// loader) is INJECTABLE, so the entire suite runs fully OFFLINE against mocks —
// no Copilot subprocess, no model download, no network, no credentials. The
// default Vitest timeouts therefore suffice. Specs live under `test/**`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
