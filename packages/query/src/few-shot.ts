// @kgpacks/query — few-shot exemplar selection (ENHANCEMENTS).
//
// Selects the `n` exemplars most similar to the query by BGE cosine similarity,
// to seed the synthesis prompt. Asymmetric, matching retrieval: the query is
// embedded with `generateQuery` (BGE prefix) and the example texts with
// `generate` (no prefix). Selection is deterministic — cosine descending with a
// lexicographic `id` tie-break — and an empty corpus (or `n <= 0`) is a no-op
// that never loads the model.

import type { FewShotEmbedder, FewShotExample } from './types.js';

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
  const exampleVectors = await embedder.generate(examples.map((example) => example.text));

  return examples
    .map((example, index) => ({
      example,
      score: queryVector === undefined ? 0 : cosine(queryVector, exampleVectors[index]),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.example.id < b.example.id ? -1 : a.example.id > b.example.id ? 1 : 0),
    )
    .slice(0, n)
    .map(({ example }) => example);
}
