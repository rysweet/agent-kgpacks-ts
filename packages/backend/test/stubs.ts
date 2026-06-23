// packages/backend/test/stubs.ts
//
// Offline fakes for the injected dependencies, so the route suites never load the
// real BGE ONNX model or spawn the Copilot subprocess.
//
//   - FakeEmbedder.generateQuery returns a fixed fixture-dimension vector (the
//     "Quantum entanglement" lead embedding by default), making chat retrieval
//     deterministic.
//   - FakeAgent.synthesizeAnswer returns a fixed answer (echoing the context ids
//     as `citedIds`); it can also be told to hang (timeout path) or fail.

import type { SynthesisRequest, SynthesisResult } from '@kgpacks/agent';
import type { Embedder } from '@kgpacks/query';

import type { ChatAgent } from '../src/index.js';
import { QE_LEAD_VECTOR } from './fixture.js';

/** Deterministic query embedder returning a fixed vector for every query. */
export class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];

  constructor(private readonly vector: number[] = QE_LEAD_VECTOR) {}

  async generateQuery(queries: string[]): Promise<Float32Array[]> {
    this.calls.push(queries);
    return queries.map(() => Float32Array.from(this.vector));
  }
}

export interface FakeAgentOptions {
  /** Answer text to return (default: a fixed sentence). */
  answer?: string;
  /** When true, `synthesizeAnswer` never resolves (drives the SSE timeout path). */
  hang?: boolean;
  /** When true, `synthesizeAnswer` rejects (drives the `AGENT_ERROR` path). */
  fail?: boolean;
}

/** Offline synthesis agent satisfying the backend's `ChatAgent` contract. */
export class FakeAgent implements ChatAgent {
  readonly calls: SynthesisRequest[] = [];

  constructor(private readonly options: FakeAgentOptions = {}) {}

  async synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult> {
    this.calls.push(request);
    if (this.options.hang) {
      return new Promise<SynthesisResult>(() => {
        /* never resolves */
      });
    }
    if (this.options.fail) {
      throw new Error('synthesis failed');
    }
    const answer = this.options.answer ?? 'This is a synthesized answer about the topic.';
    return {
      answer,
      metadata: {
        citedIds: request.context.map((chunk) => chunk.id),
        model: 'fake-model',
      },
      usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 0, totalTokens: 30 },
    };
  }
}
