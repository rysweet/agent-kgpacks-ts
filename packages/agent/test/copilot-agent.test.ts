// packages/agent/test/copilot-agent.test.ts
//
// Offline behavioral tests for `CopilotAgent` (src/copilot-agent.ts), the thin
// wrapper around the Copilot SDK that exposes the four ported operations plus
// usage accounting.
//
// Every test injects a MOCK `Transport`, so the suite runs fully offline: it
// never spawns the Copilot CLI subprocess and needs no network or credentials.
// Because the provider/model differ from the Python system and LLM output is
// non-deterministic, these assert STRUCTURAL parity only — valid shapes,
// `string[]` results, fence-stripping, citation derivation, usage accounting,
// lifecycle, and fail-closed error behavior — never exact answer text.
//
// TDD (RED): src/copilot-agent.ts / src/index.ts / src/types.ts do not exist
// yet, so these fail at import resolution today. They PASS once CopilotAgent is
// implemented to the design contract (docs/packages/agent.md).

import { describe, expect, it, vi } from 'vitest';

import {
  AgentError,
  AgentNotStartedError,
  AgentResponseFormatError,
  AgentTransportError,
  CopilotAgent,
  DEFAULT_SYNTHESIS_MODEL,
} from '../src/index.js';
import type { Transport, TransportResponse, TransportSession, Usage } from '../src/types.js';

/** Build a per-call Usage with a self-consistent total. */
function usage(promptTokens: number, completionTokens: number, reasoningTokens = 0): Usage {
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: promptTokens + completionTokens + reasoningTokens,
  };
}

type Responder = (
  prompt: string,
  timeoutMs?: number,
) => TransportResponse | Promise<TransportResponse>;

interface MockTransport {
  transport: Transport;
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

/**
 * A configurable in-memory Transport.
 *  - `respond`  controls what `send()` returns (or throws) per call.
 *  - `openImpl` lets `open()` reject, to exercise start() failure/redaction.
 */
function makeMockTransport(
  opts: { respond?: Responder; openImpl?: () => void } = {},
): MockTransport {
  const respond: Responder = opts.respond ?? (() => ({ content: '', usage: usage(0, 0) }));

  const send = vi.fn(async (prompt: string, timeoutMs?: number) => respond(prompt, timeoutMs));
  const close = vi.fn(async () => {});
  const session: TransportSession = { send, close };

  const open = vi.fn(async () => {
    if (opts.openImpl) opts.openImpl();
    return session;
  });
  const shutdown = vi.fn(async () => {});

  return { transport: { open, shutdown }, open, send, close, shutdown };
}

/** Serialize an error (message + cause) for secret-leak assertions. */
function serializeError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  let causeJson = '';
  try {
    causeJson = JSON.stringify(e.cause);
  } catch {
    causeJson = '';
  }
  return [e.message ?? '', String(e.cause ?? ''), causeJson].join(' | ');
}

async function started(
  mock: MockTransport,
  options: Record<string, unknown> = {},
): Promise<CopilotAgent> {
  const agent = new CopilotAgent({ transport: mock.transport, ...options });
  await agent.start();
  return agent;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('CopilotAgent — lifecycle', () => {
  it('construction is side-effect-free: no transport.open until start()', () => {
    const mock = makeMockTransport();
    new CopilotAgent({ transport: mock.transport });
    expect(mock.open).not.toHaveBeenCalled();
  });

  it('start() opens exactly one session pinned to the default model', async () => {
    const mock = makeMockTransport();
    await started(mock);
    expect(mock.open).toHaveBeenCalledTimes(1);
    expect(mock.open).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_SYNTHESIS_MODEL }),
    );
  });

  it('start() is idempotent — a second call does not open a second session', async () => {
    const mock = makeMockTransport();
    const agent = await started(mock);
    await agent.start();
    expect(mock.open).toHaveBeenCalledTimes(1);
  });

  it('start() forwards a constructor model override to the transport', async () => {
    const mock = makeMockTransport();
    await started(mock, { model: 'custom-pinned-model' });
    expect(mock.open).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-pinned-model' }),
    );
  });

  it('stop() closes the session and shuts the transport down', async () => {
    const mock = makeMockTransport();
    const agent = await started(mock);
    await agent.stop();
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(mock.shutdown).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent — a second call does not close/shutdown twice', async () => {
    const mock = makeMockTransport();
    const agent = await started(mock);
    await agent.stop();
    await agent.stop();
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(mock.shutdown).toHaveBeenCalledTimes(1);
  });

  it('stop() is safe to call when start() was never called', async () => {
    const mock = makeMockTransport();
    const agent = new CopilotAgent({ transport: mock.transport });
    await expect(agent.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Not-started guard
// ---------------------------------------------------------------------------

describe('CopilotAgent — not-started guard', () => {
  it('every operation rejects with AgentNotStartedError before start()', async () => {
    const mock = makeMockTransport();
    const agent = new CopilotAgent({ transport: mock.transport });

    await expect(agent.synthesizeAnswer({ question: 'q', context: [] })).rejects.toBeInstanceOf(
      AgentNotStartedError,
    );
    await expect(agent.expandQuery('q')).rejects.toBeInstanceOf(AgentNotStartedError);
    await expect(agent.multiQuery('q')).rejects.toBeInstanceOf(AgentNotStartedError);
    await expect(
      agent.identifySeedArticles({ topic: 't', candidates: ['a'] }),
    ).rejects.toBeInstanceOf(AgentNotStartedError);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('operations reject with AgentNotStartedError after stop()', async () => {
    const mock = makeMockTransport();
    const agent = await started(mock);
    await agent.stop();
    await expect(agent.expandQuery('q')).rejects.toBeInstanceOf(AgentNotStartedError);
  });

  it('getUsage() is callable before start() and reports zeros', () => {
    const mock = makeMockTransport();
    const agent = new CopilotAgent({ transport: mock.transport });
    expect(agent.getUsage()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// synthesizeAnswer
// ---------------------------------------------------------------------------

describe('CopilotAgent — synthesizeAnswer', () => {
  it('returns { answer, metadata, usage } with the model echoed', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'Synthesized grounded answer.', usage: usage(10, 20, 5) }),
    });
    const agent = await started(mock);

    const result = await agent.synthesizeAnswer({
      question: 'How does HNSW work?',
      context: [{ id: 'doc:1', text: 'HNSW builds a navigable small-world graph.' }],
    });

    expect(result.answer).toBe('Synthesized grounded answer.');
    expect(result.metadata.model).toBe(DEFAULT_SYNTHESIS_MODEL);
    expect(result.usage).toEqual(usage(10, 20, 5));
  });

  it('derives metadata.citedIds from ids appearing in the answer, in first-appearance order', async () => {
    const mock = makeMockTransport({
      respond: () => ({
        content: 'According to doc:2 and also doc:1, HNSW is layered.',
        usage: usage(1, 1),
      }),
    });
    const agent = await started(mock);

    const result = await agent.synthesizeAnswer({
      question: 'q',
      context: [
        { id: 'doc:1', text: 'a' },
        { id: 'doc:2', text: 'b' },
        { id: 'doc:3', text: 'c' },
      ],
    });

    expect(result.metadata.citedIds).toEqual(['doc:2', 'doc:1']);
  });

  it('yields empty citedIds when no chunk is referenced', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'An answer that cites nothing.', usage: usage(1, 1) }),
    });
    const agent = await started(mock);

    const result = await agent.synthesizeAnswer({
      question: 'q',
      context: [{ id: 'doc:1', text: 'a' }],
    });
    expect(result.metadata.citedIds).toEqual([]);
  });

  it('yields empty citedIds when context is empty', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'doc:1 mentioned but not in context', usage: usage(1, 1) }),
    });
    const agent = await started(mock);

    const result = await agent.synthesizeAnswer({ question: 'q', context: [] });
    expect(result.metadata.citedIds).toEqual([]);
  });

  it('does not match an id as a prefix of a longer id (Topic#1 inside Topic#10)', async () => {
    // Regression: substring indexOf reported the shorter id as cited.
    const mock = makeMockTransport({
      respond: () => ({ content: 'Only Topic#10 is relevant here.', usage: usage(1, 1) }),
    });
    const agent = await started(mock);

    const result = await agent.synthesizeAnswer({
      question: 'q',
      context: [
        { id: 'Topic#1', text: 'a' },
        { id: 'Topic#10', text: 'b' },
      ],
    });
    expect(result.metadata.citedIds).toEqual(['Topic#10']); // not ['Topic#10','Topic#1']
  });

  it('throws AgentResponseFormatError when the model returns empty content', async () => {
    const mock = makeMockTransport({ respond: () => ({ content: '', usage: usage(1, 0) }) });
    const agent = await started(mock);

    await expect(agent.synthesizeAnswer({ question: 'q', context: [] })).rejects.toBeInstanceOf(
      AgentResponseFormatError,
    );
  });
});

// ---------------------------------------------------------------------------
// expandQuery / multiQuery
// ---------------------------------------------------------------------------

describe('CopilotAgent — expandQuery / multiQuery', () => {
  it('expandQuery returns a string[] parsed from a fenced JSON array', async () => {
    const mock = makeMockTransport({
      respond: () => ({
        content: '```json\n["vector database parity","embedding retrieval equivalence"]\n```',
        usage: usage(5, 5),
      }),
    });
    const agent = await started(mock);

    await expect(agent.expandQuery('vector db parity')).resolves.toEqual([
      'vector database parity',
      'embedding retrieval equivalence',
    ]);
  });

  it('multiQuery returns a string[] parsed from a bare JSON array', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '["a","b","c"]', usage: usage(5, 5) }),
    });
    const agent = await started(mock);

    await expect(agent.multiQuery('how to install a pack', { count: 3 })).resolves.toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('throws AgentResponseFormatError when the array is not a JSON array', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '{"not":"an array"}', usage: usage(5, 5) }),
    });
    const agent = await started(mock);
    await expect(agent.expandQuery('q')).rejects.toBeInstanceOf(AgentResponseFormatError);
  });

  it('throws AgentResponseFormatError when the array contains non-strings', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '[1, 2, 3]', usage: usage(5, 5) }),
    });
    const agent = await started(mock);
    await expect(agent.expandQuery('q')).rejects.toBeInstanceOf(AgentResponseFormatError);
  });
});

// ---------------------------------------------------------------------------
// identifySeedArticles
// ---------------------------------------------------------------------------

describe('CopilotAgent — identifySeedArticles', () => {
  it('returns a string[] of selected titles from a fenced JSON array', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '```json\n["Kùzu","HNSW"]\n```', usage: usage(8, 4) }),
    });
    const agent = await started(mock);

    await expect(
      agent.identifySeedArticles({
        topic: 'graph databases',
        candidates: ['Kùzu', 'HNSW', 'Cypher', 'Apache Arrow'],
      }),
    ).resolves.toEqual(['Kùzu', 'HNSW']);
  });

  it('throws AgentResponseFormatError on a non-array response', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '"just a string"', usage: usage(8, 4) }),
    });
    const agent = await started(mock);
    await expect(
      agent.identifySeedArticles({ topic: 't', candidates: ['a'] }),
    ).rejects.toBeInstanceOf(AgentResponseFormatError);
  });

  it('enforces the optional limit cap on the number of titles returned', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '["A","B","C","D"]', usage: usage(8, 4) }),
    });
    const agent = await started(mock);

    const seeds = await agent.identifySeedArticles({
      topic: 't',
      candidates: ['A', 'B', 'C', 'D'],
      limit: 2,
    });
    expect(seeds).toHaveLength(2);
    expect(seeds).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

describe('CopilotAgent — usage accounting', () => {
  it('accumulates usage and request count across calls', async () => {
    const responses: TransportResponse[] = [
      { content: 'first answer', usage: usage(10, 20, 0) },
      { content: '["a","b"]', usage: usage(3, 4, 1) },
    ];
    let i = 0;
    const mock = makeMockTransport({ respond: () => responses[i++] });
    const agent = await started(mock);

    await agent.synthesizeAnswer({ question: 'q', context: [] });
    await agent.expandQuery('q');

    expect(agent.getUsage()).toEqual({
      promptTokens: 13,
      completionTokens: 24,
      reasoningTokens: 1,
      totalTokens: 38,
      requestCount: 2,
    });
  });

  it('the per-call Usage returned by synthesizeAnswer is NOT cumulative', async () => {
    const responses: TransportResponse[] = [
      { content: 'first', usage: usage(10, 20, 0) },
      { content: 'second', usage: usage(1, 2, 0) },
    ];
    let i = 0;
    const mock = makeMockTransport({ respond: () => responses[i++] });
    const agent = await started(mock);

    await agent.synthesizeAnswer({ question: 'q', context: [] });
    const second = await agent.synthesizeAnswer({ question: 'q', context: [] });

    expect(second.usage).toEqual(usage(1, 2, 0));
    expect(agent.getUsage().requestCount).toBe(2);
    expect(agent.getUsage().totalTokens).toBe(33);
  });

  it('getUsage() returns a copy that cannot mutate internal state', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'x', usage: usage(5, 5) }),
    });
    const agent = await started(mock);
    await agent.synthesizeAnswer({ question: 'q', context: [] });

    const snap = agent.getUsage();
    snap.totalTokens = 99999;
    expect(agent.getUsage().totalTokens).toBe(10);
  });

  it('accrues usage even when the response fails JSON validation (partial failure)', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'not-json-garbage', usage: usage(5, 5) }),
    });
    const agent = await started(mock);

    await expect(agent.expandQuery('q')).rejects.toBeInstanceOf(AgentResponseFormatError);
    const snap = agent.getUsage();
    expect(snap.promptTokens).toBe(5);
    expect(snap.completionTokens).toBe(5);
    expect(snap.requestCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout forwarding
// ---------------------------------------------------------------------------

describe('CopilotAgent — timeout forwarding', () => {
  it('forwards the constructor default timeout to send()', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: 'answer', usage: usage(1, 1) }),
    });
    const agent = await started(mock, { timeoutMs: 1234 });

    await agent.synthesizeAnswer({ question: 'q', context: [] });
    expect(mock.send).toHaveBeenLastCalledWith(expect.any(String), 1234);
  });

  it('a per-call timeout override takes precedence over the default', async () => {
    const mock = makeMockTransport({
      respond: () => ({ content: '["a"]', usage: usage(1, 1) }),
    });
    const agent = await started(mock, { timeoutMs: 1234 });

    await agent.expandQuery('q', { timeoutMs: 999 });
    expect(mock.send).toHaveBeenLastCalledWith(expect.any(String), 999);
  });
});

// ---------------------------------------------------------------------------
// Error model: transport failures, redaction, error hierarchy
// ---------------------------------------------------------------------------

describe('CopilotAgent — error model', () => {
  it('wraps an SDK send() failure as AgentTransportError (an AgentError)', async () => {
    const mock = makeMockTransport({
      respond: () => {
        throw new Error('socket hang up');
      },
    });
    const agent = await started(mock);

    const err = await agent.synthesizeAnswer({ question: 'q', context: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentTransportError);
    expect(err).toBeInstanceOf(AgentError);
  });

  it('wraps a start() failure as AgentTransportError', async () => {
    const mock = makeMockTransport({
      openImpl: () => {
        throw new Error('client failed to start');
      },
    });
    const agent = new CopilotAgent({ transport: mock.transport });
    await expect(agent.start()).rejects.toBeInstanceOf(AgentTransportError);
  });

  it('redacts the BYOK secret from the surfaced transport error', async () => {
    const secret = 'sk-secret-XYZ-should-never-leak';
    const mock = makeMockTransport({
      openImpl: () => {
        throw new Error(`connection failed: apiKey=${secret}`);
      },
    });
    const agent = new CopilotAgent({
      transport: mock.transport,
      provider: { apiKey: secret },
    });

    const err = await agent.start().catch((e) => e);
    expect(err).toBeInstanceOf(AgentTransportError);
    expect(serializeError(err)).not.toContain(secret);
  });

  it('AgentResponseFormatError carries a size-capped rawContent for diagnostics', async () => {
    const huge = 'x'.repeat(200_000);
    const mock = makeMockTransport({ respond: () => ({ content: huge, usage: usage(1, 1) }) });
    const agent = await started(mock);

    const err = await agent.expandQuery('q').catch((e) => e);
    expect(err).toBeInstanceOf(AgentResponseFormatError);
    const { rawContent } = err as AgentResponseFormatError;
    expect(typeof rawContent).toBe('string');
    expect(rawContent.length).toBeLessThan(huge.length);
  });

  it('all agent error types are catchable via the AgentError base class', () => {
    expect(new AgentNotStartedError()).toBeInstanceOf(AgentError);
    expect(new AgentTransportError('x')).toBeInstanceOf(AgentError);
    expect(new AgentResponseFormatError('x')).toBeInstanceOf(AgentError);
  });
});
