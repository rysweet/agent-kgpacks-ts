// packages/backend/test/routes.chat.test.ts
//
// Route tests for `POST /api/v1/chat`: happy-path shape, agent-unavailable `503`,
// pack-name validation (`400` / `404`), missing-question `400`, and synthesis
// failure `500`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';
import { FakeAgent } from './stubs.js';

describe('POST /api/v1/chat', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer({ agent: new FakeAgent({ answer: 'A grounded answer.' }) });
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns the ChatResponse with sources and a stable query_type', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { question: 'What is quantum entanglement?', max_results: 8 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['answer', 'execution_time_ms', 'query_type', 'sources'].sort(),
    );
    expect(body.answer).toBe('A grounded answer.');
    expect(body.query_type).toBe('vector_search');
    expect(typeof body.execution_time_ms).toBe('number');
    expect(Array.isArray(body.sources)).toBe(true);
    // Retrieval centers on the seed embedding → "Quantum entanglement" leads.
    expect(body.sources[0]).toBe('Quantum entanglement');
    expect(new Set(body.sources).size).toBe(body.sources.length); // de-duplicated

    expect(server.agent?.calls.length).toBeGreaterThan(0);
  });

  it('returns 400 MISSING_PARAMETER when question is absent', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PARAMETER');
  });

  it('returns 400 INVALID_PACK_NAME for a malformed pack', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { question: 'Hi', pack: 'Bad_Pack!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PACK_NAME');
  });

  it('returns 404 PACK_NOT_FOUND for a valid but unknown pack (Phase 1)', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { question: 'Hi', pack: 'go-expert' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PACK_NOT_FOUND');
  });
});

describe('POST /api/v1/chat — agent states', () => {
  it('returns 503 AGENT_UNAVAILABLE when no agent is configured', async () => {
    const server = await makeTestServer({ agent: null });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        payload: { question: 'What is entanglement?' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('AGENT_UNAVAILABLE');
    } finally {
      await server.close();
    }
  });

  it('returns 500 AGENT_ERROR when synthesis fails', async () => {
    const server = await makeTestServer({ agent: new FakeAgent({ fail: true }) });
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        payload: { question: 'What is entanglement?' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('AGENT_ERROR');
    } finally {
      await server.close();
    }
  });
});
