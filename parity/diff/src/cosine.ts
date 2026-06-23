// Guarded cosine similarity for the query-embedding stage.
//
// Both operands are plain number[] read from JSON / produced by the TS pipeline.
// The function divides by the L2 norms so it is correct even when either vector
// is not unit length; a zero-norm operand yields 0 (treated as a divergence by
// the caller). Dimension mismatch is a programming error here — the compare
// layer checks dimensions first and never calls this with mismatched lengths.

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
