// packages/backend/test/routes.articles.test.ts
//
// Route tests for the articles router: `GET /api/v1/articles/:title`,
// `/autocomplete`, `/categories`, `/stats`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

describe('articles router', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('GET /articles/:title returns the full ArticleDetail', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/articles/${encodeURIComponent('Quantum entanglement')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');

    const body = res.json();
    expect(body.title).toBe('Quantum entanglement');
    expect(body.category).toBe('Physics');
    expect(typeof body.word_count).toBe('number');

    // Sections ordered by section index: Introduction (level 1), History (level 2).
    expect(body.sections.map((s: { title: string }) => s.title)).toEqual([
      'Introduction',
      'History',
    ]);
    expect(Object.keys(body.sections[0]).sort()).toEqual(
      ['content', 'level', 'title', 'word_count'].sort(),
    );

    expect(body.links).toEqual(["Bell's theorem", 'EPR paradox']);
    expect(body.backlinks).toEqual(['Quantum mechanics']);
    expect(body.categories).toEqual(['Physics']);
    expect(body.wikipedia_url).toBe('https://en.wikipedia.org/wiki/Quantum_entanglement');
    expect(typeof body.last_updated).toBe('string');
  });

  it('GET /articles/:title returns 404 for an unknown article', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/articles/${encodeURIComponent('No Such Article')}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /autocomplete returns prefix matches first, then contains', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/autocomplete',
      query: { q: 'quant' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe('quant');
    expect(body.total).toBe(body.suggestions.length);

    const prefix = body.suggestions.filter(
      (s: { match_type: string }) => s.match_type === 'prefix',
    );
    const contains = body.suggestions.filter(
      (s: { match_type: string }) => s.match_type === 'contains',
    );
    expect(prefix.map((s: { title: string }) => s.title)).toEqual([
      'Quantum entanglement',
      'Quantum mechanics',
    ]);
    expect(contains.map((s: { title: string }) => s.title)).toEqual(['Loop quantum gravity']);
  });

  it('GET /autocomplete returns 400 when q is too short', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/autocomplete',
      query: { q: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });

  it('GET /categories returns counts, busiest first', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.categories).toEqual([
      { name: 'Physics', article_count: 5 },
      { name: 'Biology', article_count: 1 },
    ]);
  });

  it('GET /stats returns corpus statistics', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');

    const body = res.json();
    expect(body.articles.total).toBe(6);
    expect(body.articles.by_category).toEqual({ Physics: 5, Biology: 1 });
    expect(body.articles.by_depth).toEqual({ '0': 3, '1': 2, '2': 1 });
    expect(body.sections.total).toBe(7);
    expect(body.links.total).toBe(6);
    expect(body.database.size_mb).toBe(0); // in-memory database
    expect(body.performance).toBeNull();
  });
});
