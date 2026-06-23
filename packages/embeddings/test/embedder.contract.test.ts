// packages/embeddings/test/embedder.contract.test.ts
//
// Offline contract + edge-case tests for the @kgpacks/embeddings public stud.
//
// These exercise the API SHAPE and the documented short-circuits WITHOUT ever
// touching the model, so they run fully OFFLINE (no HF Hub download):
//   - BgeEmbedder is constructable and exposes generate / generateQuery
//   - empty input resolves to [] WITHOUT loading the pipeline
//
// The validated Spike B config (model 'Xenova/bge-base-en-v1.5', pooling 'cls',
// L2-normalize, BGE query prefix on QUERIES ONLY) and the >= 0.999 retrieval
// parity gate are covered by the network-dependent suite in parity.test.ts.
//
// TDD: these FAIL today — packages/embeddings/src/index.ts exports only the
// PACKAGE_NAME placeholder, so `BgeEmbedder` and its methods do not exist yet.
// They PASS once the embedder is implemented to the design contract.

import { describe, expect, it } from 'vitest';

import { BgeEmbedder } from '../src/index.js';

describe('@kgpacks/embeddings — BgeEmbedder contract', () => {
  it('is constructable and exposes generate() and generateQuery()', () => {
    const embedder = new BgeEmbedder();
    expect(embedder).toBeInstanceOf(BgeEmbedder);
    expect(typeof embedder.generate).toBe('function');
    expect(typeof embedder.generateQuery).toBe('function');
  });

  it('generate() and generateQuery() return Promises', () => {
    const embedder = new BgeEmbedder();
    expect(embedder.generate([])).toBeInstanceOf(Promise);
    expect(embedder.generateQuery([])).toBeInstanceOf(Promise);
  });
});

describe('@kgpacks/embeddings — empty-input short-circuit (offline)', () => {
  it('generate([]) resolves to [] without loading the model', async () => {
    const embedder = new BgeEmbedder();
    await expect(embedder.generate([])).resolves.toEqual([]);
  });

  it('generateQuery([]) resolves to [] without loading the model', async () => {
    const embedder = new BgeEmbedder();
    await expect(embedder.generateQuery([])).resolves.toEqual([]);
  });
});
