// packages/backend/test/sse-framing.test.ts
//
// Verifies the `GET /api/v1/chat/stream` wire framing: the successful
// `sources → token → done` event order with correct payloads, the timeout path
// (`event: error` / `data: TimeoutError`), and the pre-stream `503` JSON envelope
// when no agent is configured.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatSseEvent } from '../src/sse.js';
import { makeTestServer, type TestServer } from './helpers.js';
import { FakeAgent } from './stubs.js';

/** Extracts the decoded `data:` payload lines from one SSE frame. */
function dataLines(frame: string): string[] {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

describe('formatSseEvent — line splitting (CR / CRLF / LF)', () => {
  it('splits a LONE carriage return into separate data: lines', () => {
    // A bare \r is an SSE line terminator; if it stayed inside a `data:` line the
    // client (EventSource) would drop everything after it, truncating the answer.
    expect(dataLines(formatSseEvent('token', 'before\rafter'))).toEqual(['before', 'after']);
  });

  it('treats CRLF as a single line break (no empty data line between)', () => {
    expect(dataLines(formatSseEvent('token', 'a\r\nb'))).toEqual(['a', 'b']);
  });

  it('splits LF as before', () => {
    expect(dataLines(formatSseEvent('token', 'x\ny'))).toEqual(['x', 'y']);
  });

  it('keeps a single-line payload on one data: line', () => {
    expect(dataLines(formatSseEvent('token', 'plain'))).toEqual(['plain']);
  });
});

describe('GET /api/v1/chat/stream — framing', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer({
      agent: new FakeAgent({ answer: 'Entanglement links particles.' }),
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('streams sources → token → done with correct payloads', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/chat/stream',
      query: { question: 'What is entanglement?' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const body = res.payload;
    const iSources = body.indexOf('event: sources');
    const iToken = body.indexOf('event: token');
    const iDone = body.indexOf('event: done');
    expect(iSources).toBeGreaterThanOrEqual(0);
    expect(iToken).toBeGreaterThan(iSources);
    expect(iDone).toBeGreaterThan(iToken);

    // sources payload is a JSON array including the seed article.
    const sourcesData = /event: sources\ndata: (.*)\n/.exec(body)?.[1] ?? '';
    const sources = JSON.parse(sourcesData);
    expect(sources).toContain('Quantum entanglement');

    // token payload is the full answer text.
    const tokenData = /event: token\ndata: (.*)\n/.exec(body)?.[1] ?? '';
    expect(tokenData).toBe('Entanglement links particles.');

    // done payload carries query_type + execution_time_ms.
    const doneData = /event: done\ndata: (.*)\n/.exec(body)?.[1] ?? '';
    const done = JSON.parse(doneData);
    expect(done.query_type).toBe('vector_search');
    expect(typeof done.execution_time_ms).toBe('number');
  });
});

describe('GET /api/v1/chat/stream — error paths', () => {
  it('emits event: error / TimeoutError when synthesis exceeds the timeout', async () => {
    const server = await makeTestServer({
      agent: new FakeAgent({ hang: true }),
      config: { streamTimeoutMs: 50 },
    });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/chat/stream',
        query: { question: 'What is entanglement?' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('event: error');
      expect(res.payload).toContain('data: TimeoutError');
      expect(res.payload).not.toContain('event: done');
    } finally {
      await server.close();
    }
  });

  it('responds 503 JSON (not an SSE error event) when no agent is configured', async () => {
    const server = await makeTestServer({ agent: null });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/chat/stream',
        query: { question: 'What is entanglement?' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.code).toBe('AGENT_UNAVAILABLE');
      expect(res.payload).not.toContain('event:');
    } finally {
      await server.close();
    }
  });
});
