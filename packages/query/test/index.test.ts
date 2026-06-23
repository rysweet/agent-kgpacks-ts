// packages/query/test/index.test.ts
//
// Locks the public API surface of @kgpacks/query. The CORE slice promises a
// specific set of exports (the "studs"): the retriever factory, the standalone
// Cypher validator, the two retrieval primitives, the error taxonomy, and the
// overridable defaults. It must NOT leak the package-internal locked multipliers
// (GRAPH_MATCH / KEYWORD_MATCH / DEFAULT_SIMILARITY / MAX_* / MIN_*), whose
// values are fixed by parity and not part of the contract.

import { describe, expect, it } from 'vitest';

import * as query from '../src/index.js';

describe('@kgpacks/query public surface', () => {
  it('exports the documented functions and classes', () => {
    expect(typeof query.createRetriever).toBe('function');
    expect(typeof query.validateCypher).toBe('function');
    expect(typeof query.vectorRetrieve).toBe('function');
    expect(typeof query.hybridRetrieve).toBe('function');
    expect(typeof query.QueryError).toBe('function');
    expect(typeof query.CypherValidationError).toBe('function');
  });

  it('exports the overridable defaults with their reference values', () => {
    expect(query.DEFAULT_K).toBe(10);
    expect(query.DEFAULT_WEIGHTS).toEqual({ vector: 0.5, graph: 0.3, keyword: 0.2 });
    expect(query.DEFAULT_NODE_TABLE).toBe('Section');
    expect(query.DEFAULT_VECTOR_INDEX).toBe('embedding_idx');
  });

  it('exports the stop-word set used for keyword extraction', () => {
    expect(query.DEFAULT_STOP_WORDS).toBeInstanceOf(Set);
    expect(query.DEFAULT_STOP_WORDS.has('the')).toBe(true);
    expect(query.DEFAULT_STOP_WORDS.has('photosynthesis')).toBe(false);
  });

  it('does NOT leak the package-internal locked constants', () => {
    const internal = [
      'GRAPH_MATCH',
      'KEYWORD_MATCH',
      'DEFAULT_SIMILARITY',
      'MAX_GRAPH_SEEDS',
      'MAX_KEYWORDS',
      'MIN_KEYWORD_LENGTH',
      'CYPHER_BLOCKED_OPS',
      'CYPHER_ALLOWED_PREFIXES',
    ];
    for (const name of internal) {
      expect(name in query).toBe(false);
    }
  });

  it('freezes DEFAULT_WEIGHTS as a stable object identity', () => {
    expect(query.DEFAULT_WEIGHTS).toBe(query.DEFAULT_WEIGHTS);
  });
});

describe('@kgpacks/query ENHANCEMENTS surface', () => {
  it('exports the five enhancement stage entry points', () => {
    expect(typeof query.graphRerank).toBe('function');
    expect(typeof query.createCrossEncoder).toBe('function');
    expect(typeof query.selectFewShot).toBe('function');
    expect(typeof query.cypherRagRetrieve).toBe('function');
    expect(typeof query.synthesizeFromResults).toBe('function');
  });

  it('exports the agent->CypherGenerator adapter', () => {
    expect(typeof query.cypherGeneratorFromAgent).toBe('function');
  });

  it('still does NOT leak the package-internal locked constants', () => {
    for (const name of ['GRAPH_MATCH', 'KEYWORD_MATCH', 'DEFAULT_SIMILARITY']) {
      expect(name in query).toBe(false);
    }
  });
});
