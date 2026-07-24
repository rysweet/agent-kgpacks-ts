// @kgpacks/embeddings — local, in-process BGE text embeddings.
//
// Wraps Transformers.js (@huggingface/transformers, ONNX Runtime) with the
// validated Spike B configuration so TS query/document vectors reproduce the
// reference sentence-transformers BAAI/bge-base-en-v1.5 vectors closely enough to
// clear the retrieval-parity gate (cosine >= 0.999). See docs/PLAN.md and the
// package README for the full contract.

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

export { quantizeInt8, dequantizeInt8, QUANT_DIM } from './quantize.js';

// Validated Spike B configuration (cosine = 1.000000 vs the reference oracle).
// These are locked constants — there is intentionally nothing to configure.
export const BGE_MODEL_ID = 'Xenova/bge-base-en-v1.5';
const DIM = 768;
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Memoized pipeline construction promise, shared across every BgeEmbedder
// instance and both methods so the ONNX model is downloaded and loaded exactly
// once per process. Constructed lazily on first embed call.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline('feature-extraction', BGE_MODEL_ID);
  return pipelinePromise;
}

// Encodes texts in bounded SUB-BATCHES, then slices each flat [n * DIM] output
// tensor into order-preserving 768-dim Float32Array rows.
//
// Self-attention memory scales with (batch * seq_len^2), so embedding a large
// caller batch of long, variable-length texts in ONE pipeline call can allocate
// many GB (one long text pads the whole batch). Sub-batching bounds that working
// set to SUB_BATCH sequences per ONNX call; results are unchanged because each
// sequence is embedded independently (padding is attention-masked). BGE caps each
// sequence at ~512 tokens, so 64 bounded-length texts keep the attention working
// set within memory while amortizing per-call overhead for throughput.
const SUB_BATCH = 64;

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  const extractor = await getPipeline();
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += SUB_BATCH) {
    const slice = texts.slice(start, start + SUB_BATCH);
    const output = await extractor(slice, { pooling: 'cls', normalize: true });
    const flat = output.data as Float32Array;
    for (let i = 0; i < slice.length; i++) {
      vectors.push(flat.slice(i * DIM, i * DIM + DIM));
    }
  }
  return vectors;
}

/**
 * Local BGE text embedder (Transformers.js / ONNX), validated Spike B config:
 * `Xenova/bge-base-en-v1.5`, `pooling: 'cls'`, L2-normalized, 768-dimensional.
 *
 * BGE is an asymmetric retrieval model: documents are embedded raw while queries
 * are embedded with an instruction prefix. The two-method API makes the correct
 * usage the only easy usage — embed documents with {@link BgeEmbedder.generate}
 * and queries with {@link BgeEmbedder.generateQuery}.
 *
 * Constructing one is cheap and loads nothing; the underlying pipeline is created
 * lazily on first use and shared across all instances (load-once per process).
 */
export class BgeEmbedder {
  readonly modelId = BGE_MODEL_ID;

  /**
   * Embeds documents / passages. Texts are encoded verbatim — no prefix.
   *
   * Returns one L2-normalized 768-dim `Float32Array` per input, in input order.
   * An empty input array resolves to `[]` without loading the model.
   */
  async generate(texts: string[]): Promise<Float32Array[]> {
    return embed(texts);
  }

  /**
   * Embeds search queries. Each query is internally prefixed with the BGE query
   * instruction before encoding; the prefix is never applied to documents.
   *
   * Returns one L2-normalized 768-dim `Float32Array` per input, in input order.
   * An empty input array resolves to `[]` without loading the model.
   */
  async generateQuery(queries: string[]): Promise<Float32Array[]> {
    if (queries.length === 0) {
      return [];
    }
    return embed(queries.map((query) => QUERY_PREFIX + query));
  }
}
