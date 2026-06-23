// packages/query/test/retriever.test.ts
//
// Unit + error-handling tests for the `createRetriever` facade — the single
// public entry point of the CORE read path. These exercise the contract WITHOUT
// a database or the real BGE model: a recording fake `Connection` captures the
// Cypher issued (so mode dispatch, schema interpolation, and top-k binding are
// observable) and an injected `Embedder` returns a fixed vector. This isolates
// the facade's own logic — k-validation, default selection, mode routing, and
// the error taxonomy — from the LadybugDB/ONNX integration covered elsewhere.

import { describe, expect, it } from 'vitest';

import type { Connection, Row } from '@kgpacks/db';

import {
  createRetriever,
  CypherValidationError,
  QueryError,
  validateCypher,
} from '../src/index.js';
import type { Embedder } from '../src/index.js';

interface RunCall {
  cypher: string;
  params?: Record<string, unknown>;
}

type Responder = (cypher: string, params?: Record<string, unknown>) => Row[];

/**
 * A `Connection` stand-in that records every `run` call and replies via a
 * caller-supplied responder. Only `run` is exercised by the retriever, so the
 * remaining surface is intentionally absent (cast through `unknown`).
 */
class RecordingConnection {
  readonly calls: RunCall[] = [];
  constructor(private readonly responder: Responder = () => []) {}

  async run<T = Row>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    this.calls.push({ cypher, params });
    return this.responder(cypher, params) as T[];
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

/** A connection that fails the test if any query reaches the database. */
function neverQueriedConnection(): Connection {
  return new RecordingConnection(() => {
    throw new Error('connection should not be queried');
  }).asConnection();
}

/** Deterministic embedder; records how many times it was asked to embed. */
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async generateQuery(queries: string[]): Promise<Float32Array[]> {
      calls.push(queries);
      return queries.map(() => Float32Array.from([0.1, 0.2, 0.3]));
    },
  };
}

/** Two vector hits for any QUERY_VECTOR_INDEX call; empty for graph/keyword. */
const vectorResponder: Responder = (cypher) => {
  if (cypher.includes('QUERY_VECTOR_INDEX')) {
    return [
      { id: 1, content: 'first section', distance: 0.1 },
      { id: 2, content: 'second section', distance: 0.4 },
    ];
  }
  return [];
};

describe('createRetriever — k validation (fail closed before any I/O)', () => {
  const embedder = fakeEmbedder();

  const invalid: ReadonlyArray<[string, number]> = [
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [label, k] of invalid) {
    it(`rejects k = ${label} with a QueryError and never touches the connection`, async () => {
      const conn = new RecordingConnection(vectorResponder);
      const retriever = createRetriever(conn.asConnection(), { embedder });

      await expect(retriever.retrieve('q', { k })).rejects.toBeInstanceOf(QueryError);
      await expect(retriever.retrieve('q', { k })).rejects.toThrow(/k must be a positive integer/);
      expect(conn.calls).toHaveLength(0);
    });
  }

  it('accepts k = 1 (boundary) and returns results', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder });
    const results = await retriever.retrieve('q', { k: 1 });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('createRetriever — defaults', () => {
  it('defaults to vector mode (no graph/keyword queries issued)', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder: fakeEmbedder() });

    await retriever.retrieve('plain query');

    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].cypher).toContain('QUERY_VECTOR_INDEX');
    expect(conn.calls.some((c) => c.cypher.includes('LINKS_TO'))).toBe(false);
    expect(conn.calls.some((c) => c.cypher.includes('CONTAINS'))).toBe(false);
  });

  it('defaults k to 10 (bound as the vector-search limit parameter)', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder: fakeEmbedder() });

    await retriever.retrieve('plain query');

    expect(conn.calls[0].params?.k).toBe(10);
  });

  it('maps vector hits to {id, score = clamp(1 - distance), content}, nearest first', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder: fakeEmbedder() });

    const results = await retriever.retrieve('plain query', { k: 5 });

    expect(results).toEqual([
      { id: '1', score: expect.closeTo(0.9, 6), content: 'first section' },
      { id: '2', score: expect.closeTo(0.6, 6), content: 'second section' },
    ]);
  });
});

describe('createRetriever — mode dispatch', () => {
  it('issues vector + graph + keyword queries in hybrid mode', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder: fakeEmbedder() });

    await retriever.retrieve('alpha bravo charlie', { mode: 'hybrid', k: 5 });

    expect(conn.calls.some((c) => c.cypher.includes('QUERY_VECTOR_INDEX'))).toBe(true);
    expect(conn.calls.some((c) => c.cypher.includes('LINKS_TO'))).toBe(true);
    expect(conn.calls.some((c) => c.cypher.includes('CONTAINS'))).toBe(true);
  });

  it('extracts at most three significant keywords (drops short/stop words)', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder: fakeEmbedder() });

    // "the","of","a" are stop words; "to" is short — only the 4 long words remain,
    // and the keyword signal keeps the first three of those.
    await retriever.retrieve('the photosynthesis of plants relates to sunlight energy', {
      mode: 'hybrid',
      k: 5,
    });

    const keywordParams = conn.calls
      .filter((c) => c.cypher.includes('CONTAINS'))
      .map((c) => c.params?.kw);
    expect(keywordParams).toEqual(['photosynthesis', 'plants', 'relates']);
  });

  it('always embeds the query exactly once per retrieval', async () => {
    const embedder = fakeEmbedder();
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), { embedder });

    await retriever.retrieve('alpha bravo charlie', { mode: 'hybrid', k: 3 });

    expect(embedder.calls).toEqual([['alpha bravo charlie']]);
  });
});

describe('createRetriever — schema configuration', () => {
  it('interpolates the configured node table and vector index', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), {
      embedder: fakeEmbedder(),
      nodeTable: 'Chunk',
      vectorIndex: 'chunk_idx',
    });

    await retriever.retrieve('q');

    expect(conn.calls[0].cypher).toContain("'Chunk'");
    expect(conn.calls[0].cypher).toContain("'chunk_idx'");
  });
});

describe('error taxonomy', () => {
  it('CypherValidationError is a QueryError and an Error', () => {
    const err = new CypherValidationError('boom');
    expect(err).toBeInstanceOf(CypherValidationError);
    expect(err).toBeInstanceOf(QueryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CypherValidationError');
    expect(err.message).toBe('boom');
  });

  it('QueryError is the catch-all base (instanceof catches validation failures)', () => {
    try {
      validateCypher('DELETE everything');
      expect.unreachable('validateCypher should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
    }
  });

  it('createRetriever rejects with a QueryError on invalid k (not a bare Error)', async () => {
    const retriever = createRetriever(neverQueriedConnection(), { embedder: fakeEmbedder() });
    await expect(retriever.retrieve('q', { k: 0 })).rejects.toBeInstanceOf(QueryError);
  });
});
