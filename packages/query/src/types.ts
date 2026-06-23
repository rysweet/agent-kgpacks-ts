// @kgpacks/query — public types.
//
// The contract surface ("studs") for the CORE retrieval pipeline plus the
// ENHANCEMENTS layer. Kept free of implementation imports so consumers can depend
// on shapes without pulling in the database, embeddings, agent, or model runtime.

import type { SynthesisRequest, SynthesisResult } from '@kgpacks/agent';

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

  // ── ENHANCEMENTS (all optional, all default false) ──────────────────────────
  /** Stage 1: augment candidates with validated agent-generated Cypher rows. */
  enableCypherRag?: boolean;
  /** Stage 2: re-rank candidates by `LINKS_TO` graph proximity. */
  enableReranker?: boolean;
  /** Stage 3: re-score candidates with the ms-marco cross-encoder. */
  enableCrossEncoder?: boolean;
  /** Stage 4: select few-shot exemplars (synthesis only; a no-op in `retrieve`). */
  enableFewshot?: boolean;
  /** Stage 5: synthesize a multi-doc answer (synthesis only; a no-op in `retrieve`). */
  enableMultidoc?: boolean;
}

/** The public retrieval handle returned by `createRetriever`. */
export interface Retriever {
  /** Runs retrieval for `query`, returning at most `opts.k` ranked results. */
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrieverResult[]>;
  /**
   * ENHANCEMENTS: runs the full pipeline (stages 0–5) and returns a synthesized,
   * cited answer alongside the candidate list and the selected exemplars.
   */
  retrieveAndSynthesize(
    query: string,
    opts?: RetrieveOptions,
  ): Promise<RetrieveAndSynthesizeResult>;
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

// ── ENHANCEMENTS contracts ────────────────────────────────────────────────────

/**
 * Document-and-query embedder. `BgeEmbedder` satisfies it. Extends the CORE
 * {@link Embedder} (query-only) with `generate` for embedding example texts. The
 * retriever is *constructed* with the CORE `Embedder`; the few-shot stage
 * additionally requires this richer shape and fails closed otherwise.
 */
export interface FewShotEmbedder extends Embedder {
  /** Embeds document/example texts (BGE applies no prefix). */
  generate(texts: string[]): Promise<Float32Array[]>;
}

/** A single few-shot demonstration selected to seed the synthesis prompt. */
export interface FewShotExample {
  /** Stable id used for deterministic tie-breaking and traceability. */
  id: string;
  /** The exemplar text (e.g. a Q/A demonstration) embedded for similarity. */
  text: string;
}

/** Graph-reranker tuning. */
export interface RerankerOptions {
  /** Boost coefficient. Default `0.5`. */
  alpha?: number;
  /** Number of top candidates treated as traversal seeds. Default `5`. */
  seedK?: number;
  /** Graph hops to expand from each seed. Default (and current max) `1`. */
  maxHops?: number;
  /** Node table for the `LINKS_TO` traversal. Defaults to the retriever's `nodeTable`. */
  nodeTable?: string;
}

/**
 * Relevance reranker over `(query, passage)` pairs. The default implementation
 * scores with `Xenova/ms-marco-MiniLM-L-12-v2` (fp32) via
 * `AutoModelForSequenceClassification`; tests inject a fake.
 */
export interface CrossEncoder {
  /**
   * Raw relevance logits for each passage against `query`, in input order. One
   * forward pass; higher = more relevant. These are the same logits the
   * reference cross-encoder's prediction returns.
   */
  score(query: string, passages: string[]): Promise<number[]>;

  /**
   * Scores `candidates` against `query`, writes each logit back to `result.score`,
   * and returns the list sorted by logit descending with a stable (original-order)
   * tie-break. Optionally truncates to `opts.topN`.
   */
  rerank(
    query: string,
    candidates: RetrieverResult[],
    opts?: { topN?: number },
  ): Promise<RetrieverResult[]>;
}

/** Synthesis capability — satisfied directly by `CopilotAgent`. */
export interface SynthesisAgent {
  /** Combines retrieved context into a single grounded, cited answer. */
  synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult>;
}

/** Cypher-generation capability used by the Cypher-RAG stage. */
export interface CypherGenerator {
  /** Produces a single read-only Cypher statement for `question`. */
  generateCypher(question: string): Promise<string>;
}

/**
 * The combined agent contract the retriever accepts. A `CopilotAgent` provides
 * `synthesizeAnswer`; `generateCypher` is provided by `cypherGeneratorFromAgent`
 * (a thin prompt adapter exported by this package) when Cypher-RAG is enabled.
 */
export interface QueryAgent extends SynthesisAgent, Partial<CypherGenerator> {}

/** The result of {@link Retriever.retrieveAndSynthesize}. */
export interface RetrieveAndSynthesizeResult {
  /** The candidate list AFTER stages 0–3, exactly as `retrieve()` would return. */
  results: RetrieverResult[];
  /** The synthesized answer, its cited ids, and token usage for the call. */
  synthesis: SynthesisResult;
  /** The exemplars chosen by the few-shot stage (empty when disabled). */
  exemplars: FewShotExample[];
}
