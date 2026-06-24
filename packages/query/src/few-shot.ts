// @kgpacks/query — few-shot exemplar selection (ENHANCEMENTS).
//
// Selects the `n` exemplars most similar to the query by BGE cosine similarity,
// to seed the synthesis prompt. Asymmetric, matching retrieval: the query is
// embedded with `generateQuery` (BGE prefix) and the example texts with
// `generate` (no prefix). Selection is deterministic — cosine descending with a
// lexicographic `id` tie-break — and an empty corpus (or `n <= 0`) is a no-op
// that never loads the model.

import type { FewShotEmbedder, FewShotExample } from './types.js';

// The few-shot example corpus is fixed at retriever construction, so its BGE
// embeddings are query-INDEPENDENT. Cache them keyed by (embedder, examples array)
// — so a different embedder or corpus caches independently and entries GC with
// their keys — instead of re-running ONNX inference over the whole corpus on every
// query. The cached value is the in-flight promise; a failed embedding is evicted
// so the next call retries.
const exampleVectorCache = new WeakMap<
  FewShotEmbedder,
  WeakMap<FewShotExample[], Promise<Float32Array[]>>
>();

function exampleVectors(
  embedder: FewShotEmbedder,
  examples: FewShotExample[],
): Promise<Float32Array[]> {
  let perEmbedder = exampleVectorCache.get(embedder);
  if (perEmbedder === undefined) {
    perEmbedder = new WeakMap();
    exampleVectorCache.set(embedder, perEmbedder);
  }
  let cached = perEmbedder.get(examples);
  if (cached === undefined) {
    const owner = perEmbedder;
    cached = embedder.generate(examples.map((example) => example.text)).catch((err: unknown) => {
      owner.delete(examples);
      throw err;
    });
    perEmbedder.set(examples, cached);
  }
  return cached;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

/**
 * Returns the top-`n` exemplars by BGE cosine similarity to `query`, descending,
 * with a lexicographic `id` tie-break. An empty corpus or `n <= 0` resolves to
 * `[]` without embedding anything.
 */
export async function selectFewShot(
  embedder: FewShotEmbedder,
  query: string,
  examples: FewShotExample[],
  n: number,
): Promise<FewShotExample[]> {
  if (examples.length === 0 || n <= 0) {
    return [];
  }

  const [queryVector] = await embedder.generateQuery([query]);
  const vectors = await exampleVectors(embedder, examples);

  return examples
    .map((example, index) => ({
      example,
      score: queryVector === undefined ? 0 : cosine(queryVector, vectors[index]),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.example.id < b.example.id ? -1 : a.example.id > b.example.id ? 1 : 0),
    )
    .slice(0, n)
    .map(({ example }) => example);
}
