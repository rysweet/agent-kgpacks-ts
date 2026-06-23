// packages/cli/test/helpers/phase2.ts
//
// Shared fixtures for the Phase-2 INGESTION/EVAL command tests. Deliberately
// import-light (plain JSON-shaped objects, no `@kgpacks/*` imports) so every test
// file that needs a canned `buildPack` / `runEval` result can load it without
// pulling the heavy write-side packages into the module graph. The integration
// test wires the *real* `buildPack`/`@kgpacks/db` itself.

/** The element counts encoded by {@link makeBuildResult} (and printed by `create`/`update`). */
export const BUILD_COUNTS = {
  articles: 2,
  sections: 4,
  chunks: 6,
  entities: 3,
  relationships: 1,
  links: 2,
} as const;

/**
 * A canned `BuildPackResult`-shaped object with the fixed {@link BUILD_COUNTS}
 * cardinalities and the given `dbPath`. The arrays carry placeholder elements —
 * only their lengths matter, since `create`/`update` print bounded counts.
 */
export function makeBuildResult(dbPath: string): Record<string, unknown> {
  const fill = (n: number): Array<{ i: number }> =>
    Array.from({ length: n }, (_unused, i) => ({ i }));
  return {
    dbPath,
    articles: fill(BUILD_COUNTS.articles),
    sections: fill(BUILD_COUNTS.sections),
    chunks: fill(BUILD_COUNTS.chunks),
    entities: fill(BUILD_COUNTS.entities),
    relationships: fill(BUILD_COUNTS.relationships),
    links: fill(BUILD_COUNTS.links),
  };
}

/** The bounded-counts JSON `create`/`update` print for `pack` given {@link makeBuildResult}. */
export function expectedBuildCounts(pack: string, dbPath: string): Record<string, unknown> {
  return { pack, dbPath, ...BUILD_COUNTS };
}

/** A canned `EvalReport`-shaped object `pack eval` prints verbatim. */
export function makeEvalReport(): Record<string, unknown> {
  return {
    results: [],
    arms: {
      withPack: { name: 'with-pack', accuracy: 1, meanScore: 1, count: 1 },
      trainingOnly: { name: 'training-only', accuracy: 0, meanScore: 0, count: 1 },
    },
    comparison: { deltaAccuracy: 1, wins: 1, losses: 0, ties: 0, winRate: 1 },
    sampled: 1,
    total: 1,
  };
}

/** Default `pack eval` knobs the command applies when the optional flags are omitted. */
export const EVAL_DEFAULTS = {
  sample: 'full',
  perPack: 3,
  judgeModel: 'claude-opus-4.5',
} as const;

/** Default ingestion bounds surfaced by `create`/`update`/`research-sources` help + seam calls. */
export const INGEST_DEFAULTS = {
  maxDepth: 1,
  maxArticles: 50,
} as const;
