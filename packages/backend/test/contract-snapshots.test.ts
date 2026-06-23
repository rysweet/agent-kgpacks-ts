// packages/backend/test/contract-snapshots.test.ts
//
// Freezes each endpoint's JSON *shape* (key set + value types, recursively) so the
// wire contract the frontend depends on cannot drift unnoticed. Volatile values
// (timestamps, durations, similarity floats) are abstracted to their types by
// `describeShape`, so the snapshots assert structure, not data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';
import { FakeAgent } from './stubs.js';

/** Recursively reduces a value to a type signature (arrays → [elementShape]). */
function describeShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? ['<empty>'] : [describeShape(value[0])];
  }
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = describeShape((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

describe('contract snapshots', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer({ agent: new FakeAgent({ answer: 'An answer.' }) });
  });
  afterAll(async () => {
    await server.close();
  });

  it('POST /chat shape', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { question: 'What is entanglement?' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /search shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Quantum entanglement' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /hybrid-search shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/hybrid-search',
      query: { query: 'Quantum entanglement' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /graph shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph',
      query: { article: 'Quantum entanglement' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /articles/:title shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/articles/${encodeURIComponent('Quantum entanglement')}`,
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /autocomplete shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/autocomplete',
      query: { q: 'quant' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /categories shape', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /stats shape', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('GET /health shape', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/health' });
    expect(describeShape(res.json())).toMatchSnapshot();
  });

  it('error envelope shape', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Nonexistent' },
    });
    expect(describeShape(res.json())).toMatchSnapshot();
  });
});
