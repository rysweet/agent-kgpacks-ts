// packages/query/test/row.test.ts
//
// Edge-case unit tests for the result-row coercion helpers. These normalize the
// loosely-typed values LadybugDB returns (INT64 keys as number | bigint, columns
// as unknown) into the strict public shapes, and they underpin the score
// arithmetic (`clamp01(1 - distance)`) and id stringification used by every
// retrieval mode. Getting them right is a precondition for correct ranking.

import { describe, expect, it } from 'vitest';

import { clamp01, coerceContent, toIdString } from '../src/row.js';

describe('toIdString', () => {
  it('stringifies a number key', () => {
    expect(toIdString(42)).toBe('42');
    expect(toIdString(0)).toBe('0');
  });

  it('preserves full precision for bigint keys beyond Number.MAX_SAFE_INTEGER', () => {
    expect(toIdString(42n)).toBe('42');
    // 2^53 + 1 — not representable as a JS number; bigint must round-trip exactly.
    expect(toIdString(9007199254740993n)).toBe('9007199254740993');
  });

  it('falls back to String() for other primitive shapes', () => {
    expect(toIdString('abc')).toBe('abc');
    expect(toIdString(null)).toBe('null');
  });
});

describe('coerceContent', () => {
  it('returns strings unchanged', () => {
    expect(coerceContent('hello world')).toBe('hello world');
    expect(coerceContent('')).toBe('');
  });

  it('maps null and undefined to the empty string', () => {
    expect(coerceContent(null)).toBe('');
    expect(coerceContent(undefined)).toBe('');
  });

  it('stringifies other non-null values', () => {
    expect(coerceContent(123)).toBe('123');
    expect(coerceContent(true)).toBe('true');
  });
});

describe('clamp01', () => {
  it('passes through values already inside [0, 1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values to the unit interval', () => {
    expect(clamp01(-0.3)).toBe(0); // e.g. cosine distance > 1
    expect(clamp01(1.2)).toBe(1); // e.g. tiny negative distance
  });
});
