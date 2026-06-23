// packages/backend/test/rate-limit.test.ts
//
// Verifies per-route rate limiting: the `429 RATE_LIMITED` envelope when a route's
// limit is exceeded, that `rateLimit: false` disables limiting entirely, and the
// trusted-proxy `X-Forwarded-For` keying policy (honored only from a trusted peer,
// ignored otherwise to prevent key spoofing).

import { afterEach, describe, expect, it } from 'vitest';

import { makeTestServer, type TestServer } from './helpers.js';

const SEARCH_URL = '/api/v1/search';
const SEARCH_QUERY = { query: 'Quantum entanglement' };

describe('rate limiting', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('returns 429 with the RATE_LIMITED envelope once the limit is exceeded', async () => {
    server = await makeTestServer({ rateLimit: true, config: { rateLimits: { search: 2 } } });

    const a = await server.app.inject({ method: 'GET', url: SEARCH_URL, query: SEARCH_QUERY });
    const b = await server.app.inject({ method: 'GET', url: SEARCH_URL, query: SEARCH_QUERY });
    const c = await server.app.inject({ method: 'GET', url: SEARCH_URL, query: SEARCH_QUERY });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(c.statusCode).toBe(429);
    const body = c.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toBe('Rate limit exceeded');
    expect(typeof body.timestamp).toBe('string');
  });

  it('does not limit when rate limiting is disabled', async () => {
    server = await makeTestServer({ rateLimit: false, config: { rateLimits: { search: 1 } } });
    for (let i = 0; i < 5; i++) {
      const res = await server.app.inject({ method: 'GET', url: SEARCH_URL, query: SEARCH_QUERY });
      expect(res.statusCode).toBe(200);
    }
  });

  it('keys by X-Forwarded-For only when the peer is a trusted proxy', async () => {
    server = await makeTestServer({
      rateLimit: true,
      config: { trustedProxies: ['10.0.0.0/8'], rateLimits: { search: 1 } },
    });

    const fromTrusted = (xff: string) =>
      server!.app.inject({
        method: 'GET',
        url: SEARCH_URL,
        query: SEARCH_QUERY,
        remoteAddress: '10.1.2.3',
        headers: { 'x-forwarded-for': xff },
      });

    expect((await fromTrusted('client-a')).statusCode).toBe(200); // first hit for client-a
    expect((await fromTrusted('client-b')).statusCode).toBe(200); // distinct key → allowed
    expect((await fromTrusted('client-a')).statusCode).toBe(429); // client-a's second hit
  });

  it('ignores X-Forwarded-For from an untrusted peer (keyed by socket IP)', async () => {
    server = await makeTestServer({ rateLimit: true, config: { rateLimits: { search: 1 } } });

    const fromUntrusted = (xff: string) =>
      server!.app.inject({
        method: 'GET',
        url: SEARCH_URL,
        query: SEARCH_QUERY,
        remoteAddress: '9.9.9.9',
        headers: { 'x-forwarded-for': xff },
      });

    expect((await fromUntrusted('client-a')).statusCode).toBe(200);
    // Different XFF but same socket IP → shared key → limited.
    expect((await fromUntrusted('client-b')).statusCode).toBe(429);
  });
});
