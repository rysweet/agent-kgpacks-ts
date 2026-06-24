// packages/query/test/few-shot.test.ts
//
// Deterministic contract for few-shot exemplar selection (`selectFewShot`). It
// picks the top-`n` exemplars most similar to the query by BGE cosine similarity
// (asymmetric: the query is embedded with `generateQuery`, the example texts with
// `generate`), with a lexicographic `id` tie-break and an empty-corpus / n<=0
// no-op that never loads the model. A deterministic lookup embedder stands in for
// the real BGE model, so there is no network.
//
// TDD: FAILS until `selectFewShot` is implemented and exported from src/index.ts.

import { describe, expect, it } from 'vitest';

import { selectFewShot } from '../src/index.js';
import type { FewShotExample } from '../src/index.js';
import { lookupEmbedder } from './helpers.js';

// Unit vectors chosen so cosine(q, ·) is: a=1.0 > c=0.8 > b=d=0.6 (b/d tie).
const VECTORS: Record<string, number[]> = {
  q: [1, 0],
  alpha: [1, 0], // ex:a -> 1.0
  gamma: [0.8, 0.6], // ex:c -> 0.8
  beta: [0.6, 0.8], // ex:b -> 0.6
  delta: [0.6, 0.8], // ex:d -> 0.6 (ties ex:b; id breaks the tie)
};

// Deliberately NOT in cosine order, and d-before-b, to prove the ranking and the
// id tie-break (not input order) decide the result.
const EXAMPLES: FewShotExample[] = [
  { id: 'ex:d', text: 'delta' },
  { id: 'ex:b', text: 'beta' },
  { id: 'ex:c', text: 'gamma' },
  { id: 'ex:a', text: 'alpha' },
];

describe('selectFewShot — top-n by cosine, deterministic', () => {
  it('selects the n most similar exemplars in descending cosine order', async () => {
    const embedder = lookupEmbedder(VECTORS);

    const top2 = await selectFewShot(embedder, 'q', EXAMPLES, 2);

    expect(top2.map((e) => e.id)).toEqual(['ex:a', 'ex:c']);
    expect(top2).toEqual([
      { id: 'ex:a', text: 'alpha' },
      { id: 'ex:c', text: 'gamma' },
    ]);
  });

  it('breaks cosine ties lexicographically by id (ex:b before ex:d)', async () => {
    const embedder = lookupEmbedder(VECTORS);

    const top3 = await selectFewShot(embedder, 'q', EXAMPLES, 3);

    expect(top3.map((e) => e.id)).toEqual(['ex:a', 'ex:c', 'ex:b']);
  });

  it('returns the whole corpus (sorted) when n exceeds its size', async () => {
    const embedder = lookupEmbedder(VECTORS);

    const all = await selectFewShot(embedder, 'q', EXAMPLES, 99);

    expect(all.map((e) => e.id)).toEqual(['ex:a', 'ex:c', 'ex:b', 'ex:d']);
  });

  it('embeds the query asymmetrically (generateQuery) and the examples via generate', async () => {
    const embedder = lookupEmbedder(VECTORS);

    await selectFewShot(embedder, 'q', EXAMPLES, 2);

    expect(embedder.queryCalls).toEqual([['q']]);
    expect(embedder.docCalls).toEqual([['delta', 'beta', 'gamma', 'alpha']]);
  });

  it('embeds the example corpus only ONCE across repeated queries (cached), query per call', async () => {
    const embedder = lookupEmbedder(VECTORS);

    await selectFewShot(embedder, 'q1', EXAMPLES, 2);
    await selectFewShot(embedder, 'q2', EXAMPLES, 2);
    await selectFewShot(embedder, 'q3', EXAMPLES, 2);

    expect(embedder.docCalls).toHaveLength(1); // static example corpus embedded once
    expect(embedder.queryCalls).toHaveLength(3); // only the query is re-embedded per call
  });
});

describe('selectFewShot — no-op without loading the model', () => {
  it('returns [] for an empty corpus and never embeds', async () => {
    const embedder = lookupEmbedder(VECTORS);

    const out = await selectFewShot(embedder, 'q', [], 3);

    expect(out).toEqual([]);
    expect(embedder.queryCalls).toEqual([]);
    expect(embedder.docCalls).toEqual([]);
  });

  it('returns [] for n <= 0 and never embeds', async () => {
    const embedder = lookupEmbedder(VECTORS);

    expect(await selectFewShot(embedder, 'q', EXAMPLES, 0)).toEqual([]);
    expect(await selectFewShot(embedder, 'q', EXAMPLES, -1)).toEqual([]);
    expect(embedder.queryCalls).toEqual([]);
    expect(embedder.docCalls).toEqual([]);
  });
});
