// @kgpacks/query — locked constants.
//
// Ported verbatim from the reference (rysweet/agent-kgpacks
// wikigr/agent) so the TypeScript read path reproduces its behavior. Defaults
// are exposed where a caller may legitimately override them (weights, top-k),
// and fixed where parity demands it (schema names, the stop-word set).

import type { HybridWeights } from './types.js';

/** Default top-k for a retrieval call (reference `top_k`/`max_results` default). */
export const DEFAULT_K = 10;

/**
 * Default hybrid signal weights — reference `hybrid_retrieve` defaults
 * (`vector_weight=0.5, graph_weight=0.3, keyword_weight=0.2`).
 */
export const DEFAULT_WEIGHTS: HybridWeights = { vector: 0.5, graph: 0.3, keyword: 0.2 };

/**
 * Per-match graph proximity contribution multiplier. Each `LINKS_TO` neighbor of
 * a seed node adds `graph_weight * GRAPH_MATCH` (reference `graph_weight * 0.5`).
 */
export const GRAPH_MATCH = 0.5;

/**
 * Per-match keyword contribution multiplier. A title `CONTAINS` hit adds
 * `keyword_weight * KEYWORD_MATCH` (reference `keyword_weight * 0.7`).
 */
export const KEYWORD_MATCH = 0.7;

/** Default similarity used when a vector hit lacks one (reference `.get(..., 0.5)`). */
export const DEFAULT_SIMILARITY = 0.5;

/** Number of top scored nodes used as graph-traversal seeds (reference `[:3]`). */
export const MAX_GRAPH_SEEDS = 3;

/** Number of leading keywords used for the keyword signal (reference `[:3]`). */
export const MAX_KEYWORDS = 3;

/** Minimum token length for a keyword (reference `len(w) > 3`). */
export const MIN_KEYWORD_LENGTH = 3;

/** Node table searched by the vector index (reference schema `Section`). */
export const DEFAULT_NODE_TABLE = 'Section';

/** Vector index name (reference schema `embedding_idx`). */
export const DEFAULT_VECTOR_INDEX = 'embedding_idx';

// Single-format assumption (accepted limitation): the reader targets exactly ONE
// pack schema — a `Section` node table with a 768-dim `FLOAT[]` vector under the
// `embedding_idx` index, as produced by @kgpacks/ingestion. There is deliberately
// no on-disk format/schema-version field or negotiation: packs are built and read
// by the same repo at the same version, so speculative versioning would be dead
// weight. If the schema ever changes incompatibly, introduce a version marker and
// branch here; until then a mismatched/foreign pack fails fast at query time
// rather than being silently mis-read.

// ── ENHANCEMENTS constants ──────────────────────────────────────────────────

/** Default graph-reranker boost coefficient. */
export const DEFAULT_RERANK_ALPHA = 0.5;

/** Default number of top candidates used as graph-traversal seeds. */
export const DEFAULT_RERANK_SEED_K = 5;

/** Default (and current maximum) graph hops expanded from each seed. */
export const DEFAULT_RERANK_MAX_HOPS = 1;

/** Default number of few-shot exemplars selected (top-n by BGE cosine). */
export const DEFAULT_FEW_SHOT_N = 3;

/**
 * Fixed relevance score assigned to every validated Cypher-RAG row. Structural
 * graph matches are treated as fully relevant, so on a dedupe tie a Cypher row
 * supersedes the cosine-scored vector candidate for the same id.
 */
export const CYPHER_RAG_SCORE = 1;

/**
 * Hard cap on rows kept from an agent-generated Cypher query, so a broad (but
 * still read-only / validated) `MATCH … RETURN` cannot balloon memory. A tighter
 * DB-side bound depends on the generator including a `LIMIT` in the query itself.
 */
export const CYPHER_RAG_ROW_CAP = 200;

/**
 * Read-only Cypher allow-list prefixes. A validated query must start with one of
 * these (reference: `upper.startswith("MATCH") or upper.startswith("CALL")`).
 */
export const CYPHER_ALLOWED_PREFIXES = ['MATCH', 'CALL'] as const;

/**
 * Blocked write/DDL keywords (reference `_CYPHER_BLOCKED_OPS`). Any occurrence as a
 * bare token outside a string literal rejects the query.
 */
export const CYPHER_BLOCKED_OPS: ReadonlySet<string> = new Set([
  'CREATE',
  'DELETE',
  'DROP',
  'SET',
  'MERGE',
  'REMOVE',
  'DETACH',
]);

/**
 * English stop words for keyword extraction — ported verbatim from the reference
 * `KnowledgeGraphAgent.STOP_WORDS` frozenset so keyword selection matches.
 */
export const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'not',
  'no',
  'nor',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'as',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'i',
  'we',
  'you',
  'he',
  'she',
  'they',
  'me',
  'us',
  'him',
  'her',
  'them',
  'my',
  'our',
  'your',
  'his',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
]);
