// apps/frontend/src/__tests__/search.test.ts
//
// TDD contract for the read endpoints of `ApiClient`: search, hybridSearch, graph,
// and getArticle (RED until src/api/client.ts exists).
//
// Asserts, per docs/packages/frontend.md (#search, #hybridsearch, #graph,
// #getarticle) and the backend query-parameter contract:
//   - the correct GET method, path, and (encoded) query string per endpoint,
//   - happy-path decoding into the typed responses,
//   - the `404 NOT_FOUND` mapping,
//   - URL-encoding of titles that contain spaces and reserved characters, so user
//     input can never break the path, query, or framing.

import { describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client';
import type { ArticleDetail, GraphResponse, SearchResponse } from '../api/types';

import { jsonResponse, makeFetch } from './http-mocks';

const NOT_FOUND_ENVELOPE = {
  error: { code: 'NOT_FOUND', message: 'Article not found', details: null },
  timestamp: '2026-06-23T05:44:07.000Z',
};

const SEARCH_RESPONSE: SearchResponse = {
  query: 'Quantum entanglement',
  results: [
    {
      article: "Bell's theorem",
      similarity: 0.91,
      category: 'Physics',
      word_count: 1200,
      summary: 'A no-go theorem on local hidden variables.',
    },
  ],
  total: 1,
  execution_time_ms: 5,
};

describe('ApiClient.search — GET /api/v1/search', () => {
  it('GETs /search with an encoded query + limit + threshold and decodes SearchResponse', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(SEARCH_RESPONSE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    const res = await api.search({ query: 'Quantum entanglement', limit: 5, threshold: 0.2 });

    expect(res).toEqual(SEARCH_RESPONSE);
    expect(res.results[0].article).toBe("Bell's theorem");
    expect(res.total).toBe(1);

    const { url, init } = calls[0];
    expect(init?.method ?? 'GET').toBe('GET');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/search');
    expect(parsed.searchParams.get('query')).toBe('Quantum entanglement');
    expect(parsed.searchParams.get('limit')).toBe('5');
    expect(parsed.searchParams.get('threshold')).toBe('0.2');
  });

  it('encodes reserved characters in the query so they cannot break the query string', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(SEARCH_RESPONSE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await api.search({ query: 'a & b = c?', category: 'Physics/Quantum' });

    const raw = calls[0].url;
    // The literal reserved characters must not appear unencoded in the query.
    expect(raw).not.toContain('a & b = c?');
    const parsed = new URL(raw);
    expect(parsed.searchParams.get('query')).toBe('a & b = c?');
    expect(parsed.searchParams.get('category')).toBe('Physics/Quantum');
  });

  it('throws ApiClientError NOT_FOUND (404) for an unknown seed article', async () => {
    const { fetch } = makeFetch(() => jsonResponse(NOT_FOUND_ENVELOPE, { status: 404 }));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.search({ query: 'Nonexistent Article' })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('ApiClient.hybridSearch — GET /api/v1/hybrid-search', () => {
  it('GETs /hybrid-search with query + max_hops + limit and decodes SearchResponse', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(SEARCH_RESPONSE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    const res = await api.hybridSearch({ query: 'Quantum entanglement', max_hops: 3, limit: 5 });

    expect(res).toEqual(SEARCH_RESPONSE);
    const parsed = new URL(calls[0].url);
    expect(parsed.pathname).toBe('/api/v1/hybrid-search');
    expect(parsed.searchParams.get('query')).toBe('Quantum entanglement');
    expect(parsed.searchParams.get('max_hops')).toBe('3');
    expect(parsed.searchParams.get('limit')).toBe('5');
  });
});

describe('ApiClient.graph — GET /api/v1/graph', () => {
  const GRAPH_RESPONSE: GraphResponse = {
    seed: 'Quantum entanglement',
    nodes: [
      {
        id: '1',
        title: 'Quantum entanglement',
        category: 'Physics',
        word_count: 1200,
        depth: 0,
        links_count: 3,
        summary: 'Seed article.',
      },
    ],
    edges: [
      { source: 'Quantum entanglement', target: "Bell's theorem", type: 'internal', weight: 1 },
    ],
    total_nodes: 1,
    total_edges: 1,
    execution_time_ms: 7,
  };

  it('GETs /graph with the seed article + depth + limit and decodes GraphResponse', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(GRAPH_RESPONSE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    const res = await api.graph({ article: 'C++ (programming language)', depth: 2, limit: 50 });

    expect(res).toEqual(GRAPH_RESPONSE);
    const parsed = new URL(calls[0].url);
    expect(parsed.pathname).toBe('/api/v1/graph');
    // The '+' in "C++" must survive the round-trip (i.e. it was encoded, not lost).
    expect(parsed.searchParams.get('article')).toBe('C++ (programming language)');
    expect(parsed.searchParams.get('depth')).toBe('2');
    expect(parsed.searchParams.get('limit')).toBe('50');
  });

  it('throws ApiClientError NOT_FOUND (404) for an unknown graph seed', async () => {
    const { fetch } = makeFetch(() => jsonResponse(NOT_FOUND_ENVELOPE, { status: 404 }));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.graph({ article: 'Nope' })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('ApiClient.getArticle — GET /api/v1/articles/:title', () => {
  const ARTICLE: ArticleDetail = {
    title: 'Quantum entanglement',
    category: 'Physics',
    word_count: 1200,
    sections: [{ title: 'Overview', content: '…', word_count: 80, level: 2 }],
    links: ["Bell's theorem"],
    backlinks: ['Quantum mechanics'],
    categories: ['Physics'],
    wikipedia_url: 'https://en.wikipedia.org/wiki/Quantum_entanglement',
    last_updated: '2026-06-23T00:00:00.000Z',
  };

  it('encodes the title INTO THE PATH (reserved characters never create new segments)', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse(ARTICLE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await api.getArticle('A/B & C');

    const parsed = new URL(calls[0].url);
    const segments = parsed.pathname.split('/');
    // /api/v1/articles/<single-encoded-segment> — the '/' in the title must be
    // percent-encoded (%2F) so it does not split into extra path segments.
    expect(segments.slice(0, 4)).toEqual(['', 'api', 'v1', 'articles']);
    expect(segments).toHaveLength(5);
    expect(decodeURIComponent(segments[4])).toBe('A/B & C');
  });

  it('decodes ArticleDetail on success', async () => {
    const { fetch } = makeFetch(() => jsonResponse(ARTICLE));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.getArticle('Quantum entanglement')).resolves.toEqual(ARTICLE);
  });

  it('throws ApiClientError NOT_FOUND (404) when the article does not exist', async () => {
    const { fetch } = makeFetch(() => jsonResponse(NOT_FOUND_ENVELOPE, { status: 404 }));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.getArticle('Nope')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
