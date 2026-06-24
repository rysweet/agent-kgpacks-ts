// @kgpacks/query — retriever facade.
//
// The single public entry point for the read path. `createRetriever` binds a
// connection (plus optional injected embedder, agent, cross-encoder, few-shot
// corpus, and schema config) and returns a `retrieve(query, opts)` /
// `retrieveAndSynthesize(query, opts)` pair.
//
// CORE retrieval (vector/hybrid) always runs. The five ENHANCEMENTS stages are
// per-query opt-in via `enable*` flags, in a fixed order — Cypher-RAG -> graph
// reranker -> cross-encoder (candidate-list stages, honoured by `retrieve`), then
// few-shot -> multi-doc synthesis (synthesis-only, honoured by
// `retrieveAndSynthesize`). With every flag unset the result is byte-identical to
// the CORE pipeline (the flags-off invariant).

import type { Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

import {
  DEFAULT_FEW_SHOT_N,
  DEFAULT_K,
  DEFAULT_NODE_TABLE,
  DEFAULT_STOP_WORDS,
  DEFAULT_VECTOR_INDEX,
  DEFAULT_WEIGHTS,
} from './constants.js';
import { createCrossEncoder } from './cross-encoder.js';
import { cypherGeneratorFromAgent, cypherRagRetrieve } from './cypher-rag.js';
import { QueryError } from './errors.js';
import { selectFewShot } from './few-shot.js';
import { hybridRetrieve } from './hybrid.js';
import { synthesizeFromResults } from './multi-doc-synthesis.js';
import { graphRerank } from './reranker.js';
import type {
  CrossEncoder,
  CypherGenerator,
  Embedder,
  FewShotEmbedder,
  FewShotExample,
  QueryAgent,
  RerankerOptions,
  RetrieveAndSynthesizeResult,
  RetrieveOptions,
  Retriever,
  RetrieverResult,
} from './types.js';
import { vectorRetrieve, type VectorConfig } from './vector.js';

/** Construction options for {@link createRetriever}. */
export interface CreateRetrieverOptions {
  // -- CORE (unchanged) --------------------------------------------------------
  /** Query embedder. Defaults to a fresh `BgeEmbedder` (validated Spike B config). */
  embedder?: Embedder;
  /** Node table holding the embeddings. Default `'Section'`. */
  nodeTable?: string;
  /** Vector index name over that table. Default `'embedding_idx'`. */
  vectorIndex?: string;
  /** Stop words for hybrid keyword extraction. Default English set. */
  stopWords?: ReadonlySet<string>;

  // -- ENHANCEMENTS (all optional, all static) ---------------------------------
  /**
   * Agent used by multi-doc synthesis (`synthesizeAnswer`) and Cypher-RAG (Cypher
   * generation via the `cypherGeneratorFromAgent` adapter). Required only when
   * those stages are enabled.
   */
  agent?: QueryAgent;
  /**
   * Cross-encoder reranker. Defaults to a lazily-constructed singleton over
   * `Xenova/ms-marco-MiniLM-L-12-v2` (fp32). Inject a fake in tests.
   */
  crossEncoder?: CrossEncoder;
  /** Few-shot exemplar corpus. Selection is a no-op when empty. */
  fewShotExamples?: FewShotExample[];
  /** Number of exemplars the few-shot stage selects (top-n by BGE cosine). Default 3. */
  fewShotN?: number;
  /** Graph-reranker tuning. */
  reranker?: RerankerOptions;
}

function assertValidK(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new QueryError(`k must be a positive integer, got ${String(k)}`);
  }
}

/** True when `embedder` also exposes `generate` (a {@link FewShotEmbedder}). */
function isFewShotEmbedder(embedder: Embedder): embedder is FewShotEmbedder {
  return typeof (embedder as FewShotEmbedder).generate === 'function';
}

/** Adapts the configured agent into a {@link CypherGenerator} for Cypher-RAG. */
function toCypherGenerator(agent: QueryAgent): CypherGenerator {
  if (typeof agent.generateCypher === 'function') {
    const generate = agent.generateCypher.bind(agent);
    return { generateCypher: (question: string): Promise<string> => generate(question) };
  }
  return cypherGeneratorFromAgent(agent);
}

/** Merges validated Cypher rows into the vector candidates, deduped by id. */
function mergeCypherRows(
  vectorResults: RetrieverResult[],
  cypherRows: RetrieverResult[],
): RetrieverResult[] {
  const byId = new Map<string, RetrieverResult>();
  for (const result of vectorResults) {
    byId.set(result.id, result);
  }
  for (const row of cypherRows) {
    const existing = byId.get(row.id);
    // Dedupe by id; on a score tie the validated Cypher row takes precedence.
    if (existing === undefined || row.score >= existing.score) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

/**
 * Creates a retriever bound to `conn`.
 *
 * `retrieve(query, opts)` runs CORE vector/hybrid retrieval and the candidate-list
 * enhancement stages (`enableCypherRag`, `enableReranker`, `enableCrossEncoder`),
 * returning `RetrieverResult[]`. `retrieveAndSynthesize(query, opts)` additionally
 * runs few-shot selection and multi-doc synthesis, returning the candidate list,
 * the synthesized answer, and the selected exemplars.
 */
export function createRetriever(conn: Connection, opts: CreateRetrieverOptions = {}): Retriever {
  const embedder = opts.embedder ?? new BgeEmbedder();
  const config: VectorConfig = {
    nodeTable: opts.nodeTable ?? DEFAULT_NODE_TABLE,
    vectorIndex: opts.vectorIndex ?? DEFAULT_VECTOR_INDEX,
  };
  const stopWords = opts.stopWords ?? DEFAULT_STOP_WORDS;
  const fewShotExamples = opts.fewShotExamples ?? [];
  const fewShotN = opts.fewShotN ?? DEFAULT_FEW_SHOT_N;

  // Lazily resolve the cross-encoder so the flags-off path never touches it.
  let crossEncoder: CrossEncoder | undefined = opts.crossEncoder;
  const getCrossEncoder = (): CrossEncoder => {
    crossEncoder ??= createCrossEncoder();
    return crossEncoder;
  };

  // A pack's vector/FTS index lives in LadybugDB extensions that a fresh read
  // connection must LOAD before `QUERY_VECTOR_INDEX` / FTS calls resolve. The
  // build path loads them at write time; the read path must do so too. We load
  // lazily and once per retriever (VECTOR always; FTS only when hybrid needs it),
  // and skip it entirely for connections that don't expose `loadExtension`
  // (e.g. fakes injected by unit tests).
  const loader = conn as { loadExtension?: (name: string) => Promise<void> };
  let vectorReady: Promise<void> | undefined;
  let ftsReady: Promise<void> | undefined;
  async function ensureExtensions(hybrid: boolean): Promise<void> {
    if (typeof loader.loadExtension !== 'function') return;
    vectorReady ??= loader.loadExtension('vector');
    await vectorReady;
    if (hybrid) {
      ftsReady ??= loader.loadExtension('fts');
      await ftsReady;
    }
  }

  async function runCandidateStages(
    query: string,
    options: RetrieveOptions,
  ): Promise<RetrieverResult[]> {
    const k = options.k ?? DEFAULT_K;
    assertValidK(k);

    // Stage 0: CORE vector/hybrid retrieval (always runs).
    await ensureExtensions((options.mode ?? 'vector') === 'hybrid');
    let results: RetrieverResult[];
    if ((options.mode ?? 'vector') === 'hybrid') {
      const weights = options.weights ?? DEFAULT_WEIGHTS;
      results = await hybridRetrieve(conn, embedder, query, k, weights, config, stopWords);
    } else {
      results = await vectorRetrieve(conn, embedder, query, k, config);
    }

    // Stage 1: Cypher-RAG -- merge validated agent-generated Cypher rows.
    if (options.enableCypherRag === true) {
      if (opts.agent === undefined) {
        throw new QueryError('Cypher-RAG requires an agent');
      }
      const cypherRows = await cypherRagRetrieve(conn, toCypherGenerator(opts.agent), query, {
        k,
        nodeTable: config.nodeTable,
      });
      results = mergeCypherRows(results, cypherRows);
    }

    // Stage 2: graph reranker -- LINKS_TO neighbour boost.
    // Skipped when the cross-encoder is also enabled: graphRerank only re-scores a
    // membership-preserving candidate set, and the cross-encoder then overwrites
    // every score, so running the reranker's per-seed DB queries would be wasted
    // work that does not change the final result.
    if (options.enableReranker === true && options.enableCrossEncoder !== true) {
      results = await graphRerank(conn, results, {
        ...opts.reranker,
        nodeTable: opts.reranker?.nodeTable ?? config.nodeTable,
      });
    }

    // Stage 3: cross-encoder -- ms-marco relevance re-score.
    if (options.enableCrossEncoder === true) {
      results = await getCrossEncoder().rerank(query, results);
    }

    // Enforce the ranked, top-k contract regardless of which stages ran. The CORE
    // stage already returns sorted top-k (so this is a no-op there), but Cypher-RAG
    // can append extra, unranked candidates beyond k; a final stable sort + truncate
    // keeps the result ranked by score and bounded to k.
    return results
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  return {
    async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieverResult[]> {
      return runCandidateStages(query, options);
    },

    async retrieveAndSynthesize(
      query: string,
      options: RetrieveOptions = {},
    ): Promise<RetrieveAndSynthesizeResult> {
      if (opts.agent === undefined) {
        throw new QueryError('multi-doc synthesis requires an agent');
      }
      const agent = opts.agent;

      const results = await runCandidateStages(query, options);

      // Stage 4: few-shot exemplar selection (synthesis only).
      let exemplars: FewShotExample[] = [];
      if (options.enableFewshot === true) {
        if (!isFewShotEmbedder(embedder)) {
          throw new QueryError('few-shot selection requires a document embedder');
        }
        exemplars = await selectFewShot(embedder, query, fewShotExamples, fewShotN);
      }

      // Stage 5: multi-doc synthesis.
      const synthesis = await synthesizeFromResults(agent, query, results, {
        exemplars,
        multidoc: options.enableMultidoc === true,
      });

      return { results, synthesis, exemplars };
    },
  };
}
