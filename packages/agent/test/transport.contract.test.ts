// packages/agent/test/transport.contract.test.ts
//
// Offline contract tests for the Transport seam (src/transport.ts).
//
// The SDK is wrapped behind a narrow, injectable `Transport` interface so the
// rest of the suite runs offline against a mock and never spawns the Copilot CLI
// subprocess. This file pins:
//   1. `createCopilotTransport()` is exported, and constructing the real adapter
//      is side-effect-free — it does NOT spawn a subprocess or require creds
//      (the subprocess starts lazily inside `open()`), and returns a value that
//      satisfies the `Transport` shape (`open` + `shutdown`).
//   2. The structural contract any Transport must honour, demonstrated with a
//      reference in-memory mock: open() → TransportSession{send,close};
//      send() → { content, usage } with the four numeric Usage fields;
//      close()/shutdown() resolve.
//
// TDD (RED): src/transport.ts / src/index.ts do not exist yet → import fails.

import { describe, expect, it, vi } from 'vitest';

import { createCopilotTransport } from '../src/index.js';
import type { Transport, TransportResponse, TransportSession } from '../src/types.js';

describe('createCopilotTransport (real adapter shape)', () => {
  it('is exported as a function', () => {
    expect(typeof createCopilotTransport).toBe('function');
  });

  it('constructs without spawning a subprocess or throwing, returning a Transport', () => {
    // Construction must be lazy: no client.start()/subprocess until open() is
    // called. So this is safe to run offline in CI with no Copilot auth.
    const transport = createCopilotTransport();
    expect(transport).toBeTypeOf('object');
    expect(typeof transport.open).toBe('function');
    expect(typeof transport.shutdown).toBe('function');
  });
});

describe('Transport seam — structural contract (reference mock)', () => {
  function makeReferenceTransport(): Transport {
    const send = vi.fn(
      async (): Promise<TransportResponse> => ({
        content: 'hello world',
        usage: {
          promptTokens: 12,
          completionTokens: 7,
          reasoningTokens: 0,
          totalTokens: 19,
        },
      }),
    );
    const close = vi.fn(async (): Promise<void> => {});
    const session: TransportSession = { send, close };

    const open = vi.fn(async (): Promise<TransportSession> => session);
    const shutdown = vi.fn(async (): Promise<void> => {});
    return { open, shutdown };
  }

  it('open() resolves to a TransportSession exposing send() and close()', async () => {
    const transport = makeReferenceTransport();
    const session = await transport.open({ model: 'pinned-model' });
    expect(typeof session.send).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it('send() resolves with content plus a four-field numeric Usage', async () => {
    const transport = makeReferenceTransport();
    const session = await transport.open({ model: 'pinned-model' });
    const res = await session.send('a prompt', 5_000);

    expect(typeof res.content).toBe('string');
    expect(res.usage).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      reasoningTokens: 0,
      totalTokens: 19,
    });
    for (const key of [
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
      'totalTokens',
    ] as const) {
      expect(typeof res.usage[key]).toBe('number');
    }
  });

  it('close() and shutdown() resolve', async () => {
    const transport = makeReferenceTransport();
    const session = await transport.open({ model: 'pinned-model' });
    await expect(session.close()).resolves.toBeUndefined();
    await expect(transport.shutdown()).resolves.toBeUndefined();
  });
});
