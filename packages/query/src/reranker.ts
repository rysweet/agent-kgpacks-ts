// @kgpacks/query — graph reranker (ENHANCEMENTS).
//
// Deterministic re-ranking that boosts candidates which are graph neighbours of
// the strongest candidates, mirroring the upstream reranker module's proximity
// model and this package's `hybrid.ts` `LINKS_TO` accumulation. It never invents
// new nodes: only candidates already in the list can be boosted.

import type { Connection, Row } from '@kgpacks/db';

import {
  DEFAULT_NODE_TABLE,
  DEFAULT_RERANK_ALPHA,
  DEFAULT_RERANK_MAX_HOPS,
  DEFAULT_RERANK_SEED_K,
} from './constants.js';
import { toIdString } from './row.js';
import type { RerankerOptions, RetrieverResult } from './types.js';

/**
 * Re-ranks `candidates` by `LINKS_TO` graph proximity (fully deterministic):
 *
 *  1. The top-`seedK` candidates (by incoming score) are traversal seeds.
 *  2. Each seed's 1-hop `LINKS_TO` neighbours (both directions) are queried via
 *     `conn.run`, bounded by `maxHops` (current max 1).
 *  3. Every neighbour that is ALREADY a candidate gains a decayed boost
 *     `alpha * seedScore / (1 + hopDistance)`; unknown neighbours are ignored.
 *  4. The list is re-sorted by `originalScore + Σ boosts`, descending, with a
 *     stable tie-break by original rank (then `id`) for a reproducible order.
 *
 * The boosted value is written back to `result.score`. With no in-set edges the
 * list is returned unchanged.
 */
export async function graphRerank(
  conn: Connection,
  candidates: RetrieverResult[],
  options: RerankerOptions = {},
): Promise<RetrieverResult[]> {
  const alpha = options.alpha ?? DEFAULT_RERANK_ALPHA;
  const seedK = options.seedK ?? DEFAULT_RERANK_SEED_K;
  const maxHops = options.maxHops ?? DEFAULT_RERANK_MAX_HOPS;
  const nodeTable = options.nodeTable ?? DEFAULT_NODE_TABLE;

  if (candidates.length === 0 || maxHops < 1) {
    return candidates;
  }

  // Stable index map for the tie-break and candidate-membership test.
  const rankById = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (!rankById.has(candidate.id)) {
      rankById.set(candidate.id, index);
    }
  });

  // Seeds: the top-seedK candidates by incoming score (stable on ties).
  const seeds = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
    .slice(0, seedK)
    .map(({ candidate }) => candidate);

  const hopDistance = 1;
  const boosts = new Map<string, number>();

  for (const seed of seeds) {
    const neighbours = await conn.run<Row>(
      `MATCH (seed:${nodeTable} {id: $id})-[:LINKS_TO]-(neighbor:${nodeTable})
       RETURN neighbor.id AS id`,
      { id: seed.id },
    );
    for (const row of neighbours) {
      const neighbourId = toIdString(row.id);
      if (!rankById.has(neighbourId)) {
        continue;
      }
      const delta = (alpha * seed.score) / (1 + hopDistance);
      boosts.set(neighbourId, (boosts.get(neighbourId) ?? 0) + delta);
    }
  }

  return candidates
    .map((candidate, index) => ({
      result: { ...candidate, score: candidate.score + (boosts.get(candidate.id) ?? 0) },
      index,
    }))
    .sort(
      (a, b) =>
        b.result.score - a.result.score ||
        a.index - b.index ||
        (a.result.id < b.result.id ? -1 : a.result.id > b.result.id ? 1 : 0),
    )
    .map(({ result }) => result);
}
