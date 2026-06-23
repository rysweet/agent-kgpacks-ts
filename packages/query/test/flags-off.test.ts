// packages/query/test/flags-off.test.ts
//
// The FLAGS-OFF INVARIANT. With every `enable*` flag unset (the default),
// `retrieve()` must return EXACTLY what the CORE pipeline returns — same ids,
// same scores, same order — and must NOT touch any enhancement resource
// (cross-encoder, agent) or issue any extra query. This is what guarantees the
// enhancements layer adds surface area without changing CORE behaviour.
//
// TDD: FAILS until the enhancements layer is wired in such a way that, with flags
// off, it delegates byte-for-byte to the CORE vector/hybrid path.

import { describe, expect, it } from 'vitest';

import {
  createRetriever,
  DEFAULT_STOP_WORDS,
  DEFAULT_WEIGHTS,
  hybridRetrieve,
  vectorRetrieve,
} from '../src/index.js';
import {
  neverAgent,
  neverCrossEncoder,
  queryEmbedder,
  RecordingConnection,
  vectorResponder,
} from './helpers.js';

const CONFIG = { nodeTable: 'Section', vectorIndex: 'embedding_idx' };

describe('flags-off invariant — retrieve() == CORE output', () => {
  it('vector mode with no options equals vectorRetrieve', async () => {
    const core = await vectorRetrieve(
      new RecordingConnection(vectorResponder).asConnection(),
      queryEmbedder(),
      'q',
      10,
      CONFIG,
    );

    const retriever = createRetriever(new RecordingConnection(vectorResponder).asConnection(), {
      embedder: queryEmbedder(),
      crossEncoder: neverCrossEncoder(),
      agent: neverAgent(),
      fewShotExamples: [{ id: 'ex:1', text: 'demo' }],
    });
    const enhanced = await retriever.retrieve('q');

    expect(enhanced).toEqual(core);
  });

  it('explicitly setting all five flags to false also equals CORE output', async () => {
    const core = await vectorRetrieve(
      new RecordingConnection(vectorResponder).asConnection(),
      queryEmbedder(),
      'q',
      5,
      CONFIG,
    );

    const retriever = createRetriever(new RecordingConnection(vectorResponder).asConnection(), {
      embedder: queryEmbedder(),
    });
    const enhanced = await retriever.retrieve('q', {
      k: 5,
      enableCypherRag: false,
      enableReranker: false,
      enableCrossEncoder: false,
      enableFewshot: false,
      enableMultidoc: false,
    });

    expect(enhanced).toEqual(core);
  });

  it('hybrid mode with no flags equals hybridRetrieve', async () => {
    const core = await hybridRetrieve(
      new RecordingConnection(vectorResponder).asConnection(),
      queryEmbedder(),
      'alpha bravo charlie',
      5,
      DEFAULT_WEIGHTS,
      CONFIG,
      DEFAULT_STOP_WORDS,
    );

    const retriever = createRetriever(new RecordingConnection(vectorResponder).asConnection(), {
      embedder: queryEmbedder(),
      crossEncoder: neverCrossEncoder(),
      agent: neverAgent(),
    });
    const enhanced = await retriever.retrieve('alpha bravo charlie', { mode: 'hybrid', k: 5 });

    expect(enhanced).toEqual(core);
  });
});

describe('flags-off invariant — no enhancement resource is touched', () => {
  it('does not call the injected cross-encoder or agent, and issues only the vector query', async () => {
    const conn = new RecordingConnection(vectorResponder);
    const retriever = createRetriever(conn.asConnection(), {
      embedder: queryEmbedder(),
      crossEncoder: neverCrossEncoder(), // throws if used
      agent: neverAgent(), // throws if used
      fewShotExamples: [{ id: 'ex:1', text: 'demo' }],
    });

    // Would reject if any enhancement stage ran (the fakes throw on use).
    await expect(retriever.retrieve('q')).resolves.toBeDefined();

    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].cypher).toContain('QUERY_VECTOR_INDEX');
    expect(conn.calls.some((c) => c.cypher.includes('LINKS_TO'))).toBe(false);
  });
});
