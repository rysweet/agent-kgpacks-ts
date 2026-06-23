// packages/backend/test/routes.search.test.ts
//
// Route tests for `GET /api/v1/search` against the in-memory fixture: happy-path
// shape + ordering, category/threshold filtering, the `404` for an unknown seed,
// and the `400` validation envelopes (missing required / out-of-range).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

describe('GET /api/v1/search', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns the SearchResponse shape, nearest article first', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Quantum entanglement' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');

    const body = res.json();
    expect(body.query).toBe('Quantum entanglement');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.total).toBe(body.results.length);
    expect(typeof body.execution_time_ms).toBe('number');

    // The seed's own sections are excluded; Bell's theorem is the nearest article.
    const articles = body.results.map((r: { article: string }) => r.article);
    expect(articles).not.toContain('Quantum entanglement');
    expect(articles[0]).toBe("Bell's theorem");

    const first = body.results[0];
    expect(Object.keys(first).sort()).toEqual(
      ['article', 'category', 'similarity', 'summary', 'word_count'].sort(),
    );
    expect(first.category).toBe('Physics');
    expect(typeof first.word_count).toBe('number');
    expect(typeof first.summary).toBe('string');

    // Similarity is sorted strictly non-increasing.
    const sims = body.results.map((r: { similarity: number }) => r.similarity);
    for (let i = 1; i < sims.length; i++) {
      expect(sims[i]).toBeLessThanOrEqual(sims[i - 1]);
    }
  });

  it('filters by category', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Quantum entanglement', category: 'Physics' },
    });
    expect(res.statusCode).toBe(200);
    const articles = res.json().results.map((r: { article: string }) => r.article);
    expect(articles).not.toContain('Photosynthesis');
    expect(articles).toContain("Bell's theorem");
  });

  it('applies the similarity threshold', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Quantum entanglement', threshold: '0.5' },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    for (const r of results) expect(r.similarity).toBeGreaterThanOrEqual(0.5);
    // Orthogonal articles (similarity ~0) are excluded.
    const articles = results.map((r: { article: string }) => r.article);
    expect(articles).not.toContain('Photosynthesis');
    expect(articles).not.toContain('Loop quantum gravity');
  });

  it('returns 404 NOT_FOUND for an unknown seed article', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Nonexistent Article' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns 400 MISSING_PARAMETER when query is absent', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/search' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PARAMETER');
  });

  it('returns 400 INVALID_PARAMETER for an out-of-range limit', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/search',
      query: { query: 'Quantum entanglement', limit: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });
});
