// The `query_knowledge_pack` execution seam.
//
// The MCP server delegates question answering to an injectable {@link QueryRunner}.
// This keeps the server's tool wiring testable with a fixture runner and lets the
// heavy retrieval/synthesis stack stay out of the hot path until a query is
// actually issued — mirroring the upstream server, which lazily imports the agent
// inside the tool body so listing packs never pays for it.
//
// The Phase-1 {@link defaultQueryRunner} performs the CORE retrieval pass over a
// pack's LadybugDB via `@kgpacks/db` + `@kgpacks/query`. LLM answer synthesis
// (the `answer` field the upstream agent produces) lands when `@kgpacks/agent` is
// wired in a later slice; the runner type is shape-agnostic so that swap is a
// drop-in.

import type { RetrieverResult } from '@kgpacks/query';

/** Inputs handed to a {@link QueryRunner} for one `query_knowledge_pack` call. */
export interface QueryRunnerInput {
  /** Pack directory name (already validated and resolved by the server). */
  packName: string;
  /** Absolute path to the pack's `pack.db` (already confirmed to exist). */
  dbPath: string;
  /** Natural-language question to answer. */
  question: string;
  /** Maximum number of graph results to retrieve. */
  maxResults: number;
}

/**
 * Answers a question against a pack's database. The resolved value is serialized
 * verbatim into the tool result (the upstream `json.dumps(result, indent=2)`), so
 * any JSON-serializable shape is accepted — production wiring and test fixtures
 * alike.
 */
export type QueryRunner = (input: QueryRunnerInput) => Promise<unknown>;

/** Result shape produced by {@link defaultQueryRunner}. */
export interface DefaultQueryResult {
  /** Pack the question was answered against. */
  pack: string;
  /** The original question. */
  question: string;
  /** Echo of the requested result cap. */
  max_results: number;
  /** Ranked retrieval hits from the CORE pipeline. */
  results: RetrieverResult[];
}

/**
 * Builds the default production query runner.
 *
 * `@kgpacks/db` and `@kgpacks/query` are imported lazily (on first call) so that
 * merely constructing the server — or running the lightweight `list_packs` /
 * `pack_info` tools — never loads the database driver or embedding runtime.
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
        const results = await retriever.retrieve(input.question, { k: input.maxResults });
        return {
          pack: input.packName,
          question: input.question,
          max_results: input.maxResults,
          results,
        };
      } finally {
        conn.close();
      }
    } finally {
      db.close();
    }
  };
}
