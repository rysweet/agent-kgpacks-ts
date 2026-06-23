// @kgpacks/query — cross-encoder reranker (ENHANCEMENTS).
//
// Re-scores `(query, passage)` pairs with the validated Spike D configuration:
// `Xenova/ms-marco-MiniLM-L-12-v2` loaded with `AutoModelForSequenceClassification`
// at dtype `fp32`. Spike D validated this against the reference cross-encoder at
// max|diff| = 0.0000 with identical ranking, so the parity gate asserts exact
// ordering and near-exact (<=1e-3) score parity.
//
// The ONNX tokenizer + model are loaded lazily and memoized once per process,
// replicating the BGE embedder's load-once pattern.

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';

import type { CrossEncoder, RetrieverResult } from './types.js';

// Validated Spike D configuration — locked constants, nothing to configure.
const CROSS_ENCODER_MODEL = 'Xenova/ms-marco-MiniLM-L-12-v2';
const CROSS_ENCODER_DTYPE = 'fp32';

interface LoadedModel {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

// Memoized load promise, shared across every CrossEncoder instance so the ONNX
// weights are downloaded and the runtime initialized exactly once per process.
let loadPromise: Promise<LoadedModel> | null = null;

function load(): Promise<LoadedModel> {
  loadPromise ??= (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(CROSS_ENCODER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(CROSS_ENCODER_MODEL, {
        dtype: CROSS_ENCODER_DTYPE,
      }),
    ]);
    return { tokenizer, model };
  })();
  return loadPromise;
}

class MsMarcoCrossEncoder implements CrossEncoder {
  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) {
      return [];
    }
    const { tokenizer, model } = await load();
    // Pair the single query against each passage in one batched forward pass.
    const inputs = tokenizer(
      passages.map(() => query),
      { text_pair: passages, padding: true, truncation: true },
    );
    const output = (await model(inputs)) as { logits: { tolist(): number[][] } };
    // ms-marco's relevance head emits one logit per pair (shape [n, 1]).
    return output.logits.tolist().map((row) => row[0]);
  }

  async rerank(
    query: string,
    candidates: RetrieverResult[],
    opts?: { topN?: number },
  ): Promise<RetrieverResult[]> {
    const scores = await this.score(
      query,
      candidates.map((candidate) => candidate.content),
    );
    const reranked = candidates
      .map((candidate, index) => ({ result: { ...candidate, score: scores[index] }, index }))
      .sort((a, b) => b.result.score - a.result.score || a.index - b.index)
      .map(({ result }) => result);
    return opts?.topN === undefined ? reranked : reranked.slice(0, opts.topN);
  }
}

// Memoized singleton instance (the heavy model is shared via `loadPromise`).
let instance: CrossEncoder | null = null;

/**
 * Lazily constructs the singleton cross-encoder (load-once per process). The
 * underlying ONNX model is loaded on first `score`/`rerank`, never at
 * construction, so creating it is cheap.
 */
export function createCrossEncoder(): CrossEncoder {
  instance ??= new MsMarcoCrossEncoder();
  return instance;
}
