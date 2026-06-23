// packages/query/test/cypher-rag.test.ts
//
// Contract for the Cypher-RAG stage. It asks a generator for a Cypher query,
// runs it through the CORE `validateCypher` allow-list FAIL-CLOSED, executes the
// validated query, and maps the rows into `RetrieverResult[]`. Agent output is
// untrusted input: a non-read-only / write / variable-length-path query is
// rejected with `CypherValidationError` and NEVER reaches the database.
//
// `cypherGeneratorFromAgent` adapts a synthesis-only agent into a
// `CypherGenerator` by prompting it and unwrapping any Markdown code fence.
// Everything here is offline — a `RecordingConnection` and a mock agent.
//
// TDD: FAILS until `cypherRagRetrieve` / `cypherGeneratorFromAgent` are
// implemented and exported from src/index.ts.

import { describe, expect, it } from 'vitest';

import {
  cypherGeneratorFromAgent,
  cypherRagRetrieve,
  CypherValidationError,
} from '../src/index.js';
import type { CypherGenerator } from '../src/index.js';
import { fakeAgent, RecordingConnection, synthesisResult, type Responder } from './helpers.js';

const READ_CYPHER = 'MATCH (n:Section) RETURN n.id AS id, n.content AS content';

/** A generator that always returns `cypher` and records the query it saw. */
function fixedGenerator(cypher: string): CypherGenerator & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async generateCypher(question: string): Promise<string> {
      queries.push(question);
      return cypher;
    },
  };
}

/** Returns two rows for the read query; empty otherwise. */
const rowResponder: Responder = (cypher) =>
  cypher === READ_CYPHER
    ? [
        { id: 1, content: 'graph one' },
        { id: 2, content: 'graph two' },
      ]
    : [];

describe('cypherRagRetrieve — validate-then-run happy path', () => {
  it('runs the validated Cypher and maps rows to RetrieverResult[]', async () => {
    const conn = new RecordingConnection(rowResponder);
    const gen = fixedGenerator(READ_CYPHER);

    const results = await cypherRagRetrieve(conn.asConnection(), gen, 'articles about HNSW');

    expect(results.map((r) => r.id)).toEqual(['1', '2']);
    expect(results.map((r) => r.content)).toEqual(['graph one', 'graph two']);
    // Every row carries the same fixed Cypher-RAG relevance score.
    expect(results.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(results[0].score).toBe(results[1].score);
  });

  it('passes the question to the generator and runs the exact validated query', async () => {
    const conn = new RecordingConnection(rowResponder);
    const gen = fixedGenerator(READ_CYPHER);

    await cypherRagRetrieve(conn.asConnection(), gen, 'my question');

    expect(gen.queries).toEqual(['my question']);
    const runCalls = conn.calls.filter((c) => c.cypher === READ_CYPHER);
    expect(runCalls).toHaveLength(1);
  });
});

describe('cypherRagRetrieve — fail-closed on unsafe Cypher (never touches the DB)', () => {
  const unsafe: ReadonlyArray<[string, string]> = [
    ['a write/DDL keyword', 'MATCH (n:Section) DETACH DELETE n'],
    ['a non-MATCH/CALL prefix', 'CREATE (n:Section {id: 1})'],
    ['a variable-length path', 'MATCH (a:Section)-[:LINKS_TO*1..3]->(b:Section) RETURN b.id AS id'],
  ];

  for (const [label, cypher] of unsafe) {
    it(`rejects ${label} with CypherValidationError and issues no query`, async () => {
      const conn = new RecordingConnection(rowResponder);
      const gen = fixedGenerator(cypher);

      await expect(cypherRagRetrieve(conn.asConnection(), gen, 'q')).rejects.toBeInstanceOf(
        CypherValidationError,
      );
      expect(conn.calls).toHaveLength(0);
    });
  }
});

describe('cypherGeneratorFromAgent — adapts a synthesis agent', () => {
  it('returns the agent answer as a ready-to-validate Cypher string', async () => {
    const agent = fakeAgent(() => synthesisResult(READ_CYPHER));
    const gen = cypherGeneratorFromAgent(agent);

    const cypher = await gen.generateCypher('articles about HNSW');

    expect(cypher.trim()).toBe(READ_CYPHER);
    // The agent was prompted with the question embedded in the request.
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0].question).toContain('articles about HNSW');
  });

  it('unwraps a Markdown code fence so the query passes validateCypher', async () => {
    const fenced = '```cypher\n' + READ_CYPHER + '\n```';
    const agent = fakeAgent(() => synthesisResult(fenced));
    const gen = cypherGeneratorFromAgent(agent);

    expect(await gen.generateCypher('q')).toBe(READ_CYPHER);
  });

  it('drives cypherRagRetrieve end-to-end when the agent proposes a read query', async () => {
    const conn = new RecordingConnection(rowResponder);
    const agent = fakeAgent(() => synthesisResult(READ_CYPHER));

    const results = await cypherRagRetrieve(
      conn.asConnection(),
      cypherGeneratorFromAgent(agent),
      'q',
    );

    expect(results.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('still fails closed end-to-end when the agent proposes a write query', async () => {
    const conn = new RecordingConnection(rowResponder);
    const agent = fakeAgent(() => synthesisResult('MATCH (n:Section) DETACH DELETE n'));

    await expect(
      cypherRagRetrieve(conn.asConnection(), cypherGeneratorFromAgent(agent), 'q'),
    ).rejects.toBeInstanceOf(CypherValidationError);
    expect(conn.calls).toHaveLength(0);
  });
});
