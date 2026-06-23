// @kgpacks/query — public types.
//
// The contract surface ("studs") for the CORE retrieval pipeline. Kept free of
// implementation imports so consumers can depend on shapes without pulling in
// the database or embeddings runtime.

/** A single ranked retrieval hit: a node id, its score, and its section text. */
export interface RetrieverResult {
  /** Stable string form of the source node's primary key. */
  id: string;
  /**
   * Relevance score, higher is better. For `vector` mode this is cosine
   * similarity `1 - distance` clamped to `[0, 1]`; for `hybrid` mode it is the
   * weighted sum of the vector, graph, and keyword signals.
   */
  score: number;
  /** The retrieved section content. */
  content: string;
}

/** Retrieval strategy. */
export type RetrieveMode = 'vector' | 'hybrid';

/** Per-signal weights for {@link RetrieveMode} `'hybrid'`. */
export interface HybridWeights {
  /** Weight applied to the cosine-similarity signal. */
  vector: number;
  /** Weight applied to the graph-proximity (`LINKS_TO`) signal. */
  graph: number;
  /** Weight applied to the title keyword-match signal. */
  keyword: number;
}

/** Options for a single {@link Retriever.retrieve} call. */
export interface RetrieveOptions {
  /** Number of results to return (top-k). Default `10`. */
  k?: number;
  /** Retrieval strategy. Default `'vector'`. */
  mode?: RetrieveMode;
  /** Hybrid signal weights. Default `{ vector: 0.5, graph: 0.3, keyword: 0.2 }`. */
  weights?: HybridWeights;
}

/** The public retrieval handle returned by `createRetriever`. */
export interface Retriever {
  /** Runs retrieval for `query`, returning at most `opts.k` ranked results. */
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrieverResult[]>;
}

/**
 * Minimal structural contract for a query embedder.
 *
 * `@kgpacks/embeddings`' `BgeEmbedder` satisfies this. Accepting the interface
 * (rather than the concrete class) keeps the retriever injectable for tests.
 */
export interface Embedder {
  /** Embeds search queries (BGE applies its query instruction prefix). */
  generateQuery(queries: string[]): Promise<Float32Array[]>;
}
