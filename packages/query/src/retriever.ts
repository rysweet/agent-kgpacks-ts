// @kgpacks/query — retriever facade.
//
// The single public entry point for the CORE read path. `createRetriever` binds a
// connection (and an optional injected embedder + schema config) and returns a
// `retrieve(query, opts)` closure that dispatches over the requested mode.

import type { Connection } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

import {
  DEFAULT_K,
  DEFAULT_NODE_TABLE,
  DEFAULT_STOP_WORDS,
  DEFAULT_VECTOR_INDEX,
  DEFAULT_WEIGHTS,
} from './constants.js';
import { QueryError } from './errors.js';
import { hybridRetrieve } from './hybrid.js';
import type { Embedder, RetrieveOptions, Retriever, RetrieverResult } from './types.js';
import { vectorRetrieve, type VectorConfig } from './vector.js';

/** Construction options for {@link createRetriever}. */
export interface CreateRetrieverOptions {
  /** Query embedder. Defaults to a fresh `BgeEmbedder` (validated Spike B config). */
  embedder?: Embedder;
  /** Node table holding the embeddings. Default `'Section'`. */
  nodeTable?: string;
  /** Vector index name over that table. Default `'embedding_idx'`. */
  vectorIndex?: string;
  /** Stop words for hybrid keyword extraction. Default English set. */
  stopWords?: ReadonlySet<string>;
}

function assertValidK(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new QueryError(`k must be a positive integer, got ${String(k)}`);
  }
}

/**
 * Creates a retriever bound to `conn`.
 *
 * The returned object exposes `retrieve(query, opts)`, where `opts.mode` selects
 * `'vector'` (default) or `'hybrid'` retrieval, `opts.k` sets the result count
 * (default 10), and `opts.weights` overrides the hybrid signal weights.
 */
export function createRetriever(conn: Connection, opts: CreateRetrieverOptions = {}): Retriever {
  const embedder = opts.embedder ?? new BgeEmbedder();
  const config: VectorConfig = {
    nodeTable: opts.nodeTable ?? DEFAULT_NODE_TABLE,
    vectorIndex: opts.vectorIndex ?? DEFAULT_VECTOR_INDEX,
  };
  const stopWords = opts.stopWords ?? DEFAULT_STOP_WORDS;

  return {
    async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieverResult[]> {
      const k = options.k ?? DEFAULT_K;
      assertValidK(k);

      if ((options.mode ?? 'vector') === 'hybrid') {
        const weights = options.weights ?? DEFAULT_WEIGHTS;
        return hybridRetrieve(conn, embedder, query, k, weights, config, stopWords);
      }
      return vectorRetrieve(conn, embedder, query, k, config);
    },
  };
}
