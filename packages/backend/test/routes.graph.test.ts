// packages/backend/test/routes.graph.test.ts
//
// Route tests for `GET /api/v1/graph` against the in-memory fixture: node/edge
// shape, depth-ordered de-duplicated nodes, the `404` for an unknown seed, and
// `400` for an out-of-range depth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

describe('GET /api/v1/graph', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await makeTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns the neighborhood of the seed within depth', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph',
      query: { article: 'Quantum entanglement', depth: '2' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');

    const body = res.json();
    expect(body.seed).toBe('Quantum entanglement');
    expect(body.total_nodes).toBe(body.nodes.length);
    expect(body.total_edges).toBe(body.edges.length);

    // Seed at depth 0, then its 1- and 2-hop neighbors.
    const seed = body.nodes[0];
    expect(seed.id).toBe('Quantum entanglement');
    expect(seed.title).toBe('Quantum entanglement');
    expect(seed.depth).toBe(0);
    expect(seed.links_count).toBe(2); // → Bell's theorem, → EPR paradox
    expect(Object.keys(seed).sort()).toEqual(
      ['category', 'depth', 'id', 'links_count', 'summary', 'title', 'word_count'].sort(),
    );

    const titles = body.nodes.map((n: { id: string }) => n.id);
    expect(titles).toContain("Bell's theorem");
    expect(titles).toContain('EPR paradox');
    expect(titles).toContain('Quantum mechanics');
    expect(new Set(titles).size).toBe(titles.length); // de-duplicated

    // Depth is non-decreasing in traversal order.
    const depths = body.nodes.map((n: { depth: number }) => n.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }

    const edge = body.edges[0];
    expect(edge.type).toBe('internal');
    expect(edge.weight).toBe(1);
    expect(typeof edge.source).toBe('string');
    expect(typeof edge.target).toBe('string');
  });

  it('honors depth = 1 (only direct neighbors)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph',
      query: { article: 'Quantum entanglement', depth: '1' },
    });
    expect(res.statusCode).toBe(200);
    const maxDepth = Math.max(...res.json().nodes.map((n: { depth: number }) => n.depth));
    expect(maxDepth).toBe(1);
  });

  it('returns 404 for an unknown seed', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph',
      query: { article: 'Nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an out-of-range depth', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/graph',
      query: { article: 'Quantum entanglement', depth: '9' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });
});
