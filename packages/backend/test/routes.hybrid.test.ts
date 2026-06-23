// packages/backend/test/routes.hybrid.test.ts
//
// Route tests for `GET /api/v1/hybrid-search`: the `SearchResponse` shape with an
// empty `summary`, blended ordering, the `404` for an unknown seed, and the `400`
// for a missing query.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

describe('GET /api/v1/hybrid-search', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns blended results with an empty summary', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/hybrid-search',
      query: { query: 'Quantum entanglement', max_hops: '2' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');

    const body = res.json();
    expect(body.query).toBe('Quantum entanglement');
    expect(body.total).toBe(body.results.length);
    expect(body.results.length).toBeGreaterThan(0);

    const articles = body.results.map((r: { article: string }) => r.article);
    expect(articles).not.toContain('Quantum entanglement'); // seed excluded
    // Bell's theorem maximizes both signals (near vector + 1-hop link).
    expect(articles[0]).toBe("Bell's theorem");

    for (const r of body.results) {
      expect(Object.keys(r).sort()).toEqual(
        ['article', 'category', 'similarity', 'summary', 'word_count'].sort(),
      );
      expect(r.summary).toBe('');
    }

    const sims = body.results.map((r: { similarity: number }) => r.similarity);
    for (let i = 1; i < sims.length; i++) {
      expect(sims[i]).toBeLessThanOrEqual(sims[i - 1]);
    }
  });

  it('returns 404 for an unknown seed', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/hybrid-search',
      query: { query: 'Nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when query is missing', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/hybrid-search' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PARAMETER');
  });
});
