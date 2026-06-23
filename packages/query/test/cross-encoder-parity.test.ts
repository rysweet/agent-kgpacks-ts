// packages/query/test/cross-encoder-parity.test.ts
//
// Cross-encoder PARITY gate (Spike D). The one enhancements stage with an exact
// Python parity contract: `Xenova/ms-marco-MiniLM-L-12-v2` loaded with
// `AutoModelForSequenceClassification` at dtype `fp32` must reproduce the frozen
// golden relevance logits (`test/fixtures/cross-encoder-golden.json`) and the
// golden ranking. Spike D validated this config at max|diff| = 0.0000 vs the
// reference cross-encoder, so we assert score parity within 1e-3 (ONNX fp32
// numerics) and an EXACT ranking match.
//
// The fixture is the read-only oracle; it must NEVER be regenerated to make this
// pass. This is the cross-encoder analogue of the BGE embedding parity gate.
//
// NETWORK: the first run downloads the ONNX weights from the HF Hub (the package
// vitest.config.ts raises the test/hook timeouts to 120s). Subsequent runs reuse
// the Transformers.js on-disk cache.
//
// TDD: FAILS until `createCrossEncoder` is implemented and exported from
// src/index.ts.

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { createCrossEncoder } from '../src/index.js';
import type { CrossEncoder, RetrieverResult } from '../src/index.js';

interface GoldenFixture {
  ts_model: string;
  dtype: string;
  task_head: string;
  query: string;
  passages: string[];
  scores: number[];
  ranking: number[];
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/cross-encoder-golden.json', import.meta.url), 'utf8'),
) as GoldenFixture;

const TOL = 1e-3;

/** Argsort of `scores`, descending, with a stable (index) tie-break. */
function rankingOf(scores: number[]): number[] {
  return scores
    .map((s, i) => [s, i] as const)
    .sort((a, b) => b[0] - a[0] || a[0] - b[0])
    .map(([, i]) => i);
}

describe('@kgpacks/query — cross-encoder parity gate (Spike D golden logits)', () => {
  let ce: CrossEncoder;
  let scores: number[];

  beforeAll(async () => {
    // The validated Spike D config the implementation must use.
    expect(golden.ts_model).toBe('Xenova/ms-marco-MiniLM-L-12-v2');
    expect(golden.dtype).toBe('fp32');
    expect(golden.task_head).toBe('AutoModelForSequenceClassification');

    ce = createCrossEncoder();
    scores = await ce.score(golden.query, golden.passages);
  });

  it('returns one logit per passage, in input order', () => {
    expect(scores).toHaveLength(golden.passages.length);
  });

  it('reproduces the reference logits within 1e-3', () => {
    golden.scores.forEach((expected, i) => {
      expect(Math.abs(scores[i] - expected), `passage[${i}]`).toBeLessThanOrEqual(TOL);
    });
  });

  it('produces the exact golden ranking', () => {
    expect(rankingOf(scores)).toEqual(golden.ranking);
  });

  it('rerank() orders candidates by logit desc and writes the logit back to score', async () => {
    const candidates: RetrieverResult[] = golden.passages.map((content, i) => ({
      id: String(i),
      score: 0,
      content,
    }));

    const reranked = await ce.rerank(golden.query, candidates);

    expect(reranked.map((r) => Number(r.id))).toEqual(golden.ranking);
    // score is now the relevance logit (monotonically non-increasing).
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].score).toBeGreaterThanOrEqual(reranked[i].score);
    }
    // The top-ranked passage carries the highest golden logit.
    expect(reranked[0].score).toBeCloseTo(Math.max(...golden.scores), 3);
  });

  it('rerank() truncates to topN', async () => {
    const candidates: RetrieverResult[] = golden.passages.map((content, i) => ({
      id: String(i),
      score: 0,
      content,
    }));

    const top2 = await ce.rerank(golden.query, candidates, { topN: 2 });

    expect(top2).toHaveLength(2);
    expect(top2.map((r) => Number(r.id))).toEqual(golden.ranking.slice(0, 2));
  });
});
