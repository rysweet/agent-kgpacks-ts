// packages/backend/test/config.test.ts
//
// Unit tests for `loadConfig` / `mergeConfig`: defaults, `WIKIGR_*` overrides,
// and the immutability guarantee.

import { describe, expect, it } from 'vitest';

import { loadConfig, mergeConfig } from '../src/index.js';

describe('loadConfig', () => {
  it('returns the documented defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config.apiVersion).toBe('1.0.0');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8000);
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.streamTimeoutMs).toBe(60_000);
    expect(config.corsOrigins).toHaveLength(4);
    expect(config.rateLimits).toEqual({
      chat: 5,
      search: 10,
      hybrid: 10,
      graph: 20,
      articles: 30,
      autocomplete: 60,
      categories: 30,
      stats: 30,
    });
    expect(config.cacheTtl).toEqual({ default: 3600, article: 86_400, stats: 300 });
  });

  it('applies WIKIGR_* overrides', () => {
    const config = loadConfig({
      WIKIGR_PORT: '9999',
      WIKIGR_RATE_LIMIT_ENABLED: 'false',
      WIKIGR_CORS_ORIGINS: 'https://a.example, https://b.example',
      WIKIGR_RATE_LIMIT_SEARCH: '99',
      WIKIGR_STREAM_TIMEOUT_S: '5',
      WIKIGR_TRUSTED_PROXIES: '10.0.0.0/8, 1.2.3.4',
      WIKIGR_DATABASE_PATH: '/data/pack.lbug',
    });
    expect(config.port).toBe(9999);
    expect(config.rateLimitEnabled).toBe(false);
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(config.rateLimits.search).toBe(99);
    expect(config.streamTimeoutMs).toBe(5000);
    expect(config.trustedProxies).toEqual(['10.0.0.0/8', '1.2.3.4']);
    expect(config.databasePath).toBe('/data/pack.lbug');
  });

  it('produces a frozen settings object', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.rateLimits)).toBe(true);
    expect(Object.isFrozen(config.cacheTtl)).toBe(true);
  });
});

describe('mergeConfig', () => {
  it('shallow-merges partial top-level and nested overrides', () => {
    const base = loadConfig({});
    const merged = mergeConfig(base, {
      port: 1234,
      rateLimits: { search: 1 },
      cacheTtl: { stats: 10 },
    });
    expect(merged.port).toBe(1234);
    expect(merged.rateLimits.search).toBe(1);
    expect(merged.rateLimits.chat).toBe(5); // untouched
    expect(merged.cacheTtl.stats).toBe(10);
    expect(merged.cacheTtl.default).toBe(3600); // untouched
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it('returns the base unchanged when no override is given', () => {
    const base = loadConfig({});
    expect(mergeConfig(base)).toBe(base);
  });
});
