// apps/frontend/src/__tests__/client.test.ts
//
// TDD contract for the typed `ApiClient` over a mocked `fetch` (RED until
// src/api/client.ts, src/api/errors.ts, and src/api/types.ts exist).
//
// Asserts, per docs/packages/frontend.md#api-client-reference and #error-model:
//   - base-URL joining + the `/api/v1` prefix,
//   - POST /chat body shape, JSON content-type, and credential-omission,
//   - happy-path decoding into the typed responses,
//   - a 4xx/5xx envelope → `ApiClientError` with code/status/message/details,
//   - the status→code fallback when the error body is NOT a well-formed envelope,
//   - a fetch rejection (transport failure) → NETWORK_ERROR / status null,
//   - the supporting endpoints, including `health()` resolving on 503.

import { describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client';
import { ApiClientError } from '../api/errors';
import type {
  AutocompleteResponse,
  CategoriesResponse,
  ChatResponse,
  HealthResponse,
  StatsResponse,
} from '../api/types';

import { headerValue, jsonResponse, makeFetch, textResponse } from './http-mocks';

describe('ApiClient — chat (POST /api/v1/chat)', () => {
  it('joins baseUrl + /api/v1/chat, sends a JSON body, omits credentials, and decodes ChatResponse', async () => {
    const payload: ChatResponse = {
      answer: 'Entanglement links two particles into one shared state.',
      sources: ['Quantum entanglement', "Bell's theorem"],
      query_type: 'vector_search',
      execution_time_ms: 12,
    };
    const { fetch, calls } = makeFetch(() => jsonResponse(payload));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    const res = await api.chat({ question: 'What is quantum entanglement?', max_results: 8 });

    expect(res).toEqual(payload);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('http://api.test/api/v1/chat');
    expect(init?.method).toBe('POST');
    expect(headerValue(init?.headers, 'content-type')).toMatch(/application\/json/i);
    // Security model: no credentials on the wire.
    expect(init?.credentials).toBe('omit');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.question).toBe('What is quantum entanglement?');
    expect(body.max_results).toBe(8);
  });

  it('throws an ApiClientError carrying code/status/message/details from a 4xx envelope', async () => {
    const envelope = {
      error: {
        code: 'INVALID_PARAMETER',
        message: 'question must be 1–500 characters',
        details: { field: 'question' },
      },
      timestamp: '2026-06-23T05:44:07.000Z',
    };
    const { fetch } = makeFetch(() => jsonResponse(envelope, { status: 400 }));
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch });

    expect.assertions(5);
    try {
      await api.chat({ question: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const e = err as ApiClientError;
      expect(e.code).toBe('INVALID_PARAMETER');
      expect(e.status).toBe(400);
      expect(e.message).toBe('question must be 1–500 characters');
      expect(e.details).toEqual({ field: 'question' });
    }
  });
});

describe('ApiClient — error model', () => {
  it('falls back to the status→code map when the error body is not a well-formed envelope', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [400, 'INVALID_PARAMETER'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [503, 'AGENT_UNAVAILABLE'],
      [500, 'INTERNAL_ERROR'],
      [418, 'INTERNAL_ERROR'],
    ];

    for (const [status, code] of cases) {
      const { fetch } = makeFetch(() => textResponse('<html>gateway error</html>', { status }));
      const api = new ApiClient({ baseUrl: 'http://api.test', fetch });
      await expect(api.stats()).rejects.toMatchObject({
        name: 'ApiClientError',
        code,
        status,
      });
    }
  });

  it('maps a fetch rejection (transport failure) to NETWORK_ERROR with a null status', async () => {
    const failingFetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = new ApiClient({ baseUrl: 'http://api.test', fetch: failingFetch });

    await expect(api.stats()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NETWORK_ERROR',
      status: null,
    });
  });
});

describe('ApiClient — supporting endpoints', () => {
  it('autocomplete() GETs /api/v1/autocomplete with an encoded q + limit', async () => {
    const payload: AutocompleteResponse = {
      query: 'qu',
      suggestions: [{ title: 'Quantum entanglement', category: 'Physics', match_type: 'prefix' }],
      total: 1,
    };
    const { fetch, calls } = makeFetch(() => jsonResponse(payload));
    const api = new ApiClient({ baseUrl: '', fetch });

    const res = await api.autocomplete({ q: 'qu', limit: 5 });

    expect(res).toEqual(payload);
    const url = new URL(calls[0].url, 'http://local');
    expect(url.pathname).toBe('/api/v1/autocomplete');
    expect(url.searchParams.get('q')).toBe('qu');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('categories() and stats() GET their endpoints and decode the response body', async () => {
    const categories: CategoriesResponse = {
      categories: [{ name: 'Physics', article_count: 42 }],
      total: 1,
    };
    const stats: StatsResponse = {
      articles: { total: 100, by_category: { Physics: 42 }, by_depth: { '0': 1 } },
      sections: { total: 500, avg_per_article: 5 },
      links: { total: 800, avg_per_article: 8 },
      database: { size_mb: 12.5, last_updated: '2026-06-23T00:00:00.000Z' },
      performance: null,
    };

    const catClient = makeFetch(() => jsonResponse(categories));
    const api1 = new ApiClient({ baseUrl: 'http://api.test', fetch: catClient.fetch });
    await expect(api1.categories()).resolves.toEqual(categories);
    expect(catClient.calls[0].url).toBe('http://api.test/api/v1/categories');

    const statClient = makeFetch(() => jsonResponse(stats));
    const api2 = new ApiClient({ baseUrl: 'http://api.test', fetch: statClient.fetch });
    await expect(api2.stats()).resolves.toEqual(stats);
    expect(statClient.calls[0].url).toBe('http://api.test/api/v1/stats');
  });

  it('health() resolves the body for BOTH 200 (healthy) and 503 (unhealthy) — never throws', async () => {
    const healthy: HealthResponse = {
      status: 'healthy',
      version: '1.0.0',
      database: 'connected',
      timestamp: '2026-06-23T05:44:07.000Z',
    };
    const unhealthy: HealthResponse = {
      status: 'unhealthy',
      version: '1.0.0',
      database: 'disconnected',
      timestamp: '2026-06-23T05:44:07.000Z',
    };

    const okClient = makeFetch(() => jsonResponse(healthy, { status: 200 }));
    const api1 = new ApiClient({ baseUrl: 'http://api.test', fetch: okClient.fetch });
    await expect(api1.health()).resolves.toEqual(healthy);

    const downClient = makeFetch(() => jsonResponse(unhealthy, { status: 503 }));
    const api2 = new ApiClient({ baseUrl: 'http://api.test', fetch: downClient.fetch });
    await expect(api2.health()).resolves.toEqual(unhealthy);
  });
});
