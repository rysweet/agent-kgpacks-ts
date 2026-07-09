// @kgpacks/query — public entry point.
//
// The CORE retrieval pipeline (vector and hybrid retrieval over a LadybugDB pack,
// plus the read-only Cypher safety validator) and the ENHANCEMENTS layer: graph
// reranker, cross-encoder, multi-document synthesis, few-shot selection, and
// Cypher-RAG. See docs/enhancements.md and the package README for the contract.

export { createRetriever } from './retriever.js';
export type { CreateRetrieverOptions } from './retriever.js';

export { validateCypher } from './cypher-safety.js';

export { vectorRetrieve } from './vector.js';
export { hybridRetrieve } from './hybrid.js';
export { lexicalRetrieve } from './lexical.js';

export { QueryError, CypherValidationError, RerankOptionError } from './errors.js';

export {
  DEFAULT_K,
  DEFAULT_WEIGHTS,
  DEFAULT_STOP_WORDS,
  DEFAULT_NODE_TABLE,
  DEFAULT_VECTOR_INDEX,
  PACK_DB_VERSION,
} from './constants.js';

export type {
  Embedder,
  HybridWeights,
  Retriever,
  RetrieverResult,
  RetrieveMode,
  RetrieveOptions,
} from './types.js';

// ── ENHANCEMENTS surface ──────────────────────────────────────────────────────

export { graphRerank } from './reranker.js';
export { createCrossEncoder } from './cross-encoder.js';
export { selectFewShot } from './few-shot.js';
export { cypherRagRetrieve, cypherGeneratorFromAgent } from './cypher-rag.js';
export { synthesizeFromResults } from './multi-doc-synthesis.js';

export { entityGraph } from './entity-graph.js';
export type {
  EntityGraphMode,
  ResolvedEntityGraphMode,
  EntityGraphOptions,
  EntityGraphNode,
  EntityGraphEdge,
  EntityGraphResult,
} from './entity-graph.js';

export type {
  RerankerOptions,
  CrossEncoder,
  FewShotExample,
  FewShotEmbedder,
  QueryAgent,
  SynthesisAgent,
  CypherGenerator,
  RetrieveAndSynthesizeResult,
} from './types.js';

// Re-exported from @kgpacks/agent for caller convenience.
export type { SynthesisRequest, SynthesisResult, ContextChunk } from '@kgpacks/agent';
