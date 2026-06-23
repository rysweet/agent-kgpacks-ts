// packages/query/test/helpers.ts
//
// Shared OFFLINE fakes for the @kgpacks/query ENHANCEMENTS test-suite. None of
// these touch the network, a real database, or a real model — the reranker,
// few-shot, Cypher-RAG, multi-doc, wiring, and flags-off suites are fully
// deterministic. Only `cross-encoder-parity.test.ts` loads a real model.
//
// This is NOT a `*.test.ts` file, so vitest never collects it as a suite; it is
// imported by the suites that need a `Connection`, an embedder, a cross-encoder,
// or an agent stand-in.

import type { Connection, Row } from '@kgpacks/db';
import type { SynthesisRequest, SynthesisResult } from '@kgpacks/agent';

import type {
  CrossEncoder,
  Embedder,
  FewShotEmbedder,
  RetrieverResult,
  SynthesisAgent,
} from '../src/index.js';

// ── Recording connection ────────────────────────────────────────────────────

export interface RunCall {
  cypher: string;
  params?: Record<string, unknown>;
}

export type Responder = (cypher: string, params?: Record<string, unknown>) => Row[];

/**
 * A `Connection` stand-in that records every `run` call and replies via a
 * caller-supplied responder. Only `run` is exercised by the read path, so the
 * remaining surface is intentionally absent (cast through `unknown`).
 */
export class RecordingConnection {
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
export function neverQueriedConnection(): Connection {
  return new RecordingConnection(() => {
    throw new Error('connection should not be queried');
  }).asConnection();
}

/**
 * Two vector hits for any `QUERY_VECTOR_INDEX` call; empty for graph/keyword.
 * `id`/`distance` chosen so the mapped scores are `0.9` and `0.6`.
 */
export const vectorResponder: Responder = (cypher) => {
  if (cypher.includes('QUERY_VECTOR_INDEX')) {
    return [
      { id: 1, content: 'first section', distance: 0.1 },
      { id: 2, content: 'second section', distance: 0.4 },
    ];
  }
  return [];
};

// ── Embedders ───────────────────────────────────────────────────────────────

/** A query-only `Embedder` (no `generate`); records the texts it embedded. */
export function queryEmbedder(
  vector: number[] = [0.1, 0.2, 0.3],
): Embedder & { queryCalls: string[][] } {
  const queryCalls: string[][] = [];
  return {
    queryCalls,
    async generateQuery(queries: string[]): Promise<Float32Array[]> {
      queryCalls.push(queries);
      return queries.map(() => Float32Array.from(vector));
    },
  };
}

/**
 * A deterministic document-AND-query embedder (`FewShotEmbedder`) backed by a
 * `text -> vector` lookup table, recording every call to each method. Texts
 * absent from the table fall back to `fallback` so callers can ignore vectors
 * that do not influence the assertion under test (e.g. the query vector during
 * pure vector retrieval).
 */
export function lookupEmbedder(
  table: Record<string, number[]>,
  fallback: number[] = [1, 0],
): FewShotEmbedder & { queryCalls: string[][]; docCalls: string[][] } {
  const queryCalls: string[][] = [];
  const docCalls: string[][] = [];
  const lookup = (text: string): Float32Array => Float32Array.from(table[text] ?? fallback);
  return {
    queryCalls,
    docCalls,
    async generateQuery(queries: string[]): Promise<Float32Array[]> {
      queryCalls.push(queries);
      return queries.map(lookup);
    },
    async generate(texts: string[]): Promise<Float32Array[]> {
      docCalls.push(texts);
      return texts.map(lookup);
    },
  };
}

// ── Cross-encoder ─────────────────────────────────────────────────────────────

export interface RerankCall {
  query: string;
  candidates: RetrieverResult[];
  topN?: number;
}

/**
 * A fake `CrossEncoder` whose logits come from a caller-supplied `scoreFn`
 * (`content -> logit`). `rerank` follows the documented contract: it scores each
 * candidate, writes the logit back to `score`, sorts descending with a stable
 * (original-order) tie-break, and truncates to `topN`. Records every call.
 */
export function fakeCrossEncoder(scoreFn: (content: string) => number): CrossEncoder & {
  scoreCalls: Array<{ query: string; passages: string[] }>;
  rerankCalls: RerankCall[];
} {
  const scoreCalls: Array<{ query: string; passages: string[] }> = [];
  const rerankCalls: RerankCall[] = [];
  return {
    scoreCalls,
    rerankCalls,
    async score(query: string, passages: string[]): Promise<number[]> {
      scoreCalls.push({ query, passages });
      return passages.map(scoreFn);
    },
    async rerank(
      query: string,
      candidates: RetrieverResult[],
      opts?: { topN?: number },
    ): Promise<RetrieverResult[]> {
      rerankCalls.push({ query, candidates, topN: opts?.topN });
      const reranked = candidates
        .map((c, i) => ({ result: { ...c, score: scoreFn(c.content) }, i }))
        .sort((a, b) => b.result.score - a.result.score || a.i - b.i)
        .map(({ result }) => result);
      return opts?.topN === undefined ? reranked : reranked.slice(0, opts.topN);
    },
  };
}

/** A cross-encoder that fails the test if it is ever used (flags-off guard). */
export function neverCrossEncoder(): CrossEncoder {
  return {
    async score(): Promise<number[]> {
      throw new Error('cross-encoder should not run');
    },
    async rerank(): Promise<RetrieverResult[]> {
      throw new Error('cross-encoder should not run');
    },
  };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

/** Builds a `SynthesisResult` with the agent's exact public shape. */
export function synthesisResult(answer: string, citedIds: string[] = []): SynthesisResult {
  return {
    answer,
    metadata: { citedIds, model: 'fake-model' },
    usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 },
  };
}

/**
 * A `SynthesisAgent` stand-in. By default it echoes a canned answer; pass a
 * `responder` to vary the answer by request (used by the Cypher-RAG adapter
 * tests, where the agent's answer IS the generated Cypher). Records every
 * `SynthesisRequest` it received.
 */
export function fakeAgent(
  responder: (req: SynthesisRequest) => SynthesisResult = () =>
    synthesisResult('canned answer', []),
): SynthesisAgent & { requests: SynthesisRequest[] } {
  const requests: SynthesisRequest[] = [];
  return {
    requests,
    async synthesizeAnswer(req: SynthesisRequest): Promise<SynthesisResult> {
      requests.push(req);
      return responder(req);
    },
  };
}

/** An agent that fails the test if it is ever used (flags-off guard). */
export function neverAgent(): SynthesisAgent {
  return {
    async synthesizeAnswer(): Promise<SynthesisResult> {
      throw new Error('agent should not be called');
    },
  };
}
