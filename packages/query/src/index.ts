// @kgpacks/query — public entry point.
//
// The CORE retrieval pipeline (Phase 1): vector and hybrid retrieval over a
// LadybugDB pack, plus the read-only Cypher safety validator. Reranker,
// multi-document synthesis, few-shot prompting, and Cypher-RAG land in a later
// slice. See docs/PLAN.md and the package README for the contract.

export { createRetriever } from './retriever.js';
export type { CreateRetrieverOptions } from './retriever.js';

export { validateCypher } from './cypher-safety.js';

export { vectorRetrieve } from './vector.js';
export { hybridRetrieve } from './hybrid.js';

export { QueryError, CypherValidationError } from './errors.js';

export {
  DEFAULT_K,
  DEFAULT_WEIGHTS,
  DEFAULT_STOP_WORDS,
  DEFAULT_NODE_TABLE,
  DEFAULT_VECTOR_INDEX,
} from './constants.js';

export type {
  Embedder,
  HybridWeights,
  Retriever,
  RetrieverResult,
  RetrieveMode,
  RetrieveOptions,
} from './types.js';
