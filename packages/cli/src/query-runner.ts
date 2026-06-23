// The `query` execution seam.
//
// `query` delegates retrieval to an injectable {@link QueryRunner}, mirroring the
// `@kgpacks/mcp` design. This keeps the command testable with a fixture runner
// and — crucially — keeps the heavy retrieval stack (`@kgpacks/db`,
// `@kgpacks/query`, and the embeddings/ONNX runtime it pulls in) out of the
// always-loaded module graph: the production runner `import()`s them lazily, only
// when a query is actually issued.

import type { RetrieveMode } from '@kgpacks/query';

/** Inputs handed to a {@link QueryRunner} for one `query` invocation. */
export interface QueryRunnerInput {
  /** Pack directory name (already validated and resolved). */
  packName: string;
  /** Absolute path to the pack's `pack.db` (already confirmed to exist). */
  dbPath: string;
  /** Natural-language question. */
  question: string;
  /** Number of results to retrieve (top-k). */
  k: number;
  /** Retrieval strategy. */
  mode: RetrieveMode;
}

/**
 * Answers a question against a pack's database. The resolved value is serialized
 * verbatim to stdout as pretty JSON, so any JSON-serializable shape is accepted —
 * production wiring and test fixtures alike.
 */
export type QueryRunner = (input: QueryRunnerInput) => Promise<unknown>;

/** Result shape produced by {@link defaultQueryRunner}. */
export interface DefaultQueryResult {
  /** Pack the question was answered against. */
  pack: string;
  /** The original question. */
  question: string;
  /** Echo of the requested result count. */
  k: number;
  /** Ranked retrieval hits from the CORE pipeline. */
  results: unknown;
}

/**
 * Builds the default production query runner.
 *
 * `@kgpacks/db` and `@kgpacks/query` are imported lazily (on first call) so that
 * merely constructing the program — or running any non-`query` command — never
 * loads the database driver or the embedding runtime.
 */
export function defaultQueryRunner(): QueryRunner {
  return async (input: QueryRunnerInput): Promise<DefaultQueryResult> => {
    const { Database } = await import('@kgpacks/db');
    const { createRetriever } = await import('@kgpacks/query');

    const db = new Database(input.dbPath);
    try {
      const conn = db.connect();
      try {
        const retriever = createRetriever(conn);
        const results = await retriever.retrieve(input.question, {
          k: input.k,
          mode: input.mode,
        });
        return { pack: input.packName, question: input.question, k: input.k, results };
      } finally {
        conn.close();
      }
    } finally {
      db.close();
    }
  };
}
