// packages/backend/test/routes.graph-entities.test.ts
//
// TDD (RED): GET /api/v1/graph/entities is not registered yet, so these requests
// currently 404 (route-not-found) instead of returning the validation envelopes
// below. It encodes the request-validation contract from docs/entity-graph.md — a
// required `entity`, bounded `depth` (1..3) and `limit` (1..200), and an enum
// `mode` — rendered as the standard 400 envelope (MISSING_PARAMETER /
// INVALID_PARAMETER). The node/edge neighborhood shape, auto mode selection, and
// the unknown-entity 404 are covered by the transport-agnostic core in
// packages/query/test/entity-graph.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

describe('GET /api/v1/graph/entities — request validation', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('requires the `entity` query parameter (400 MISSING_PARAMETER)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/graph/entities' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PARAMETER');
  });

  it('rejects an out-of-range depth (400 INVALID_PARAMETER)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph/entities',
      query: { entity: 'CWE-79', depth: '9' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });

  it('rejects an out-of-range limit (400 INVALID_PARAMETER)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph/entities',
      query: { entity: 'CWE-79', limit: '9999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });

  it('rejects an unknown traversal mode (400 INVALID_PARAMETER)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph/entities',
      query: { entity: 'CWE-79', mode: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });
});
