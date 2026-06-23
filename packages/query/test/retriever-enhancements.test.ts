// packages/query/test/retriever-enhancements.test.ts
//
// Wiring contract: how `createRetriever` exposes the five enhancement stages.
//   - `retrieve()` honours enableCypherRag / enableReranker / enableCrossEncoder
//     (the candidate-list stages, in that fixed order) and IGNORES enableFewshot
//     / enableMultidoc (synthesis-only) so its return type never changes.
//   - `retrieveAndSynthesize()` runs the full pipeline and returns
//     `{ results, synthesis, exemplars }`.
//   - Stages fail closed when their static resource is missing.
// Everything is offline: a `RecordingConnection`, a fake cross-encoder, a fake
// agent, and a deterministic lookup embedder.
//
// TDD: FAILS until the enhancement stages are wired into `createRetriever`
// (extended options + enable flags + `retrieveAndSynthesize`).

import { describe, expect, it } from 'vitest';

import { createRetriever, CypherValidationError, QueryError } from '../src/index.js';
import {
  fakeAgent,
  fakeCrossEncoder,
  lookupEmbedder,
  queryEmbedder,
  RecordingConnection,
  synthesisResult,
  type Responder,
} from './helpers.js';

const READ_CYPHER = 'MATCH (n:Section) RETURN n.id AS id, n.content AS content';

// ── enableCrossEncoder ────────────────────────────────────────────────────────

describe('retrieve — enableCrossEncoder', () => {
  const responder: Responder = (cypher) =>
    cypher.includes('QUERY_VECTOR_INDEX')
      ? [
          { id: 1, content: 'aaa', distance: 0.1 }, // vector score 0.9
          { id: 2, content: 'bbb', distance: 0.4 }, // vector score 0.6
        ]
      : [];

  it('re-scores and re-orders candidates via the injected cross-encoder', async () => {
    const conn = new RecordingConnection(responder);
    const ce = fakeCrossEncoder((content) => (content === 'bbb' ? 10 : 1));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(),
      crossEncoder: ce,
    });

    const out = await retriever.retrieve('q', { enableCrossEncoder: true });

    expect(out).toEqual([
      { id: '2', score: 10, content: 'bbb' },
      { id: '1', score: 1, content: 'aaa' },
    ]);
    expect(ce.rerankCalls).toHaveLength(1);
    expect(ce.rerankCalls[0].query).toBe('q');
    expect(ce.rerankCalls[0].candidates.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('does not invoke the cross-encoder when the flag is off', async () => {
    const conn = new RecordingConnection(responder);
    const ce = fakeCrossEncoder(() => 99);
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(),
      crossEncoder: ce,
    });

    const out = await retriever.retrieve('q');

    expect(out.map((r) => r.id)).toEqual(['1', '2']);
    expect(ce.rerankCalls).toHaveLength(0);
  });
});

// ── enableReranker ────────────────────────────────────────────────────────────

describe('retrieve — enableReranker', () => {
  const responder: Responder = (cypher, params) => {
    if (cypher.includes('QUERY_VECTOR_INDEX')) {
      return [
        { id: 1, content: 'aaa', distance: 0.5 }, // vector score 0.5
        { id: 2, content: 'bbb', distance: 0.6 }, // vector score 0.4
      ];
    }
    if (cypher.includes('LINKS_TO') && String(params?.id) === '1') {
      return [{ id: 2 }]; // node 1 -> node 2
    }
    return [];
  };

  it('applies the graph neighbour-boost and re-sorts', async () => {
    const conn = new RecordingConnection(responder);
    const retriever = createRetriever(conn.asConnection(), { embedder: queryEmbedder() });

    // boost(2) = 0.5 * 0.5 / 2 = 0.125 -> 0.525 > 0.5
    const out = await retriever.retrieve('q', { enableReranker: true });

    expect(out.map((r) => r.id)).toEqual(['2', '1']);
    expect(out.find((r) => r.id === '2')?.score).toBeCloseTo(0.525, 10);
  });

  it('issues no LINKS_TO traversal when the flag is off', async () => {
    const conn = new RecordingConnection(responder);
    const retriever = createRetriever(conn.asConnection(), { embedder: queryEmbedder() });

    const out = await retriever.retrieve('q');

    expect(out.map((r) => r.id)).toEqual(['1', '2']);
    expect(conn.calls.some((c) => c.cypher.includes('LINKS_TO'))).toBe(false);
  });
});

// ── enableCypherRag ───────────────────────────────────────────────────────────

describe('retrieve — enableCypherRag', () => {
  const responder: Responder = (cypher) => {
    if (cypher.includes('QUERY_VECTOR_INDEX')) {
      return [
        { id: 1, content: 'vec one', distance: 0.1 },
        { id: 2, content: 'vec two', distance: 0.3 },
      ];
    }
    if (cypher === READ_CYPHER) {
      return [
        { id: 2, content: 'graph two' },
        { id: 3, content: 'graph three' },
      ];
    }
    return [];
  };

  it('merges validated agent Cypher rows with the vector candidates, deduped by id', async () => {
    const conn = new RecordingConnection(responder);
    const agent = fakeAgent(() => synthesisResult(READ_CYPHER));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(),
      agent,
    });

    const out = await retriever.retrieve('q', { enableCypherRag: true });

    const ids = out.map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(['1', '2', '3']));
    expect(ids.filter((id) => id === '2')).toHaveLength(1); // deduped
    expect(agent.requests).toHaveLength(1);
    expect(conn.calls.some((c) => c.cypher === READ_CYPHER)).toBe(true);
  });

  it('fails closed (QueryError) when enabled without an agent', async () => {
    const conn = new RecordingConnection(responder);
    const retriever = createRetriever(conn.asConnection(), { embedder: queryEmbedder() });

    await expect(retriever.retrieve('q', { enableCypherRag: true })).rejects.toBeInstanceOf(
      QueryError,
    );
  });

  it('rejects an agent-proposed write query and never runs it', async () => {
    const conn = new RecordingConnection(responder);
    const agent = fakeAgent(() => synthesisResult('MATCH (n:Section) DETACH DELETE n'));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(),
      agent,
    });

    await expect(retriever.retrieve('q', { enableCypherRag: true })).rejects.toBeInstanceOf(
      CypherValidationError,
    );
    expect(conn.calls.some((c) => c.cypher.includes('DELETE'))).toBe(false);
  });
});

// ── retrieve ignores synthesis-only flags ─────────────────────────────────────

describe('retrieve — synthesis-only flags are a no-op', () => {
  const responder: Responder = (cypher) =>
    cypher.includes('QUERY_VECTOR_INDEX')
      ? [
          { id: 1, content: 'aaa', distance: 0.1 },
          { id: 2, content: 'bbb', distance: 0.4 },
        ]
      : [];

  it('ignores enableFewshot / enableMultidoc and never calls the agent', async () => {
    const conn = new RecordingConnection(responder);
    const agent = fakeAgent(() => synthesisResult('should not be used'));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: lookupEmbedder({ q: [1, 0], demo: [1, 0] }),
      agent,
      fewShotExamples: [{ id: 'ex:1', text: 'demo' }],
    });

    const out = await retriever.retrieve('q', { enableFewshot: true, enableMultidoc: true });

    expect(out.map((r) => r.id)).toEqual(['1', '2']);
    expect(agent.requests).toHaveLength(0);
  });
});

// ── retrieveAndSynthesize ─────────────────────────────────────────────────────

describe('retrieveAndSynthesize — full pipeline', () => {
  const responder: Responder = (cypher) =>
    cypher.includes('QUERY_VECTOR_INDEX')
      ? [
          { id: 1, content: 'alpha', distance: 0.1 }, // score 0.9
          { id: 2, content: 'beta', distance: 0.4 }, // score 0.6
        ]
      : [];

  const embedder = () => lookupEmbedder({ q: [1, 0], 'good demo': [1, 0], 'bad demo': [0, 1] });

  const fewShotExamples = [
    { id: 'ex:1', text: 'good demo' },
    { id: 'ex:2', text: 'bad demo' },
  ];

  it('returns { results, synthesis, exemplars } and grounds synthesis in the results', async () => {
    const conn = new RecordingConnection(responder);
    const canned = synthesisResult('the cited answer', ['1']);
    const agent = fakeAgent(() => canned);
    const retriever = createRetriever(conn.asConnection(), {
      embedder: embedder(),
      agent,
      fewShotExamples,
      fewShotN: 1,
    });

    const out = await retriever.retrieveAndSynthesize('q', {
      enableFewshot: true,
      enableMultidoc: true,
    });

    expect(out.results).toEqual([
      { id: '1', score: expect.closeTo(0.9, 6), content: 'alpha' },
      { id: '2', score: expect.closeTo(0.6, 6), content: 'beta' },
    ]);
    expect(out.synthesis).toEqual(canned);
    expect(out.exemplars).toEqual([{ id: 'ex:1', text: 'good demo' }]);

    // Multidoc => full list as context; question carries the exemplar + original.
    expect(agent.requests[0].context).toEqual([
      { id: '1', text: 'alpha' },
      { id: '2', text: 'beta' },
    ]);
    expect(agent.requests[0].question).toContain('good demo');
    expect(agent.requests[0].question).toContain('q');
  });

  it('grounds on the single top result and selects no exemplars when both flags are off', async () => {
    const conn = new RecordingConnection(responder);
    const agent = fakeAgent(() => synthesisResult('answer'));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: embedder(),
      agent,
      fewShotExamples,
    });

    const out = await retriever.retrieveAndSynthesize('q');

    expect(out.exemplars).toEqual([]);
    expect(agent.requests[0].context).toEqual([{ id: '1', text: 'alpha' }]);
  });

  it('fails closed (QueryError) when no agent is configured', async () => {
    const conn = new RecordingConnection(responder);
    const retriever = createRetriever(conn.asConnection(), { embedder: embedder() });

    await expect(retriever.retrieveAndSynthesize('q')).rejects.toBeInstanceOf(QueryError);
    await expect(retriever.retrieveAndSynthesize('q')).rejects.toThrow(/agent/i);
  });

  it('fails closed when few-shot is enabled with a query-only embedder', async () => {
    const conn = new RecordingConnection(responder);
    const agent = fakeAgent(() => synthesisResult('answer'));
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(), // no `generate` -> cannot embed exemplars
      agent,
      fewShotExamples,
    });

    await expect(
      retriever.retrieveAndSynthesize('q', { enableFewshot: true }),
    ).rejects.toBeInstanceOf(QueryError);
    await expect(retriever.retrieveAndSynthesize('q', { enableFewshot: true })).rejects.toThrow(
      /few-shot/i,
    );
  });
});
