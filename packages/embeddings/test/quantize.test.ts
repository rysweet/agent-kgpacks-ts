// packages/embeddings/test/quantize.test.ts
//
// TDD (RED): @kgpacks/embeddings does not yet export the int8 vector codec, so this
// suite fails at import today. It encodes the docs/pack-quantization.md contract —
// per-vector int8 quantization with `scale = max(|v|) / 127`, a bound-checked
// decoder that fails closed on a wrong length / non-finite input, and cosine
// similarity (the retrieval metric) preserved within tolerance. It passes once
// `quantizeInt8` / `dequantizeInt8` land, gating the WS2 adoption decision.

import { describe, expect, it } from 'vitest';

import { quantizeInt8, dequantizeInt8 } from '../src/index.js';

const DIM = 768;

/** Deterministic, L2-normalized pseudo-random vector (BGE outputs are normalized). */
function unitVector(seed: number): Float32Array {
  let s = seed >>> 0;
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = s / 0xffffffff - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('quantizeInt8 / dequantizeInt8', () => {
  it('encodes to an Int8Array(768) with scale = max(|v|) / 127', () => {
    const v = unitVector(1);
    const { codes, scale } = quantizeInt8(v);
    expect(codes).toBeInstanceOf(Int8Array);
    expect(codes.length).toBe(DIM);

    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeCloseTo(max / 127, 6);

    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(-128);
      expect(c).toBeLessThanOrEqual(127);
    }
  });

  it('round-trips within one quantization step per element', () => {
    const v = unitVector(2);
    const { codes, scale } = quantizeInt8(v);
    const approx = dequantizeInt8(codes, scale);
    expect(approx).toBeInstanceOf(Float32Array);
    expect(approx.length).toBe(DIM);
    for (let i = 0; i < DIM; i++) {
      expect(Math.abs(approx[i] - v[i])).toBeLessThanOrEqual(scale + 1e-6);
    }
  });

  it('preserves cosine similarity above the retrieval-parity threshold', () => {
    for (const seed of [3, 4, 5, 6]) {
      const v = unitVector(seed);
      const { codes, scale } = quantizeInt8(v);
      const approx = dequantizeInt8(codes, scale);
      expect(cosine(v, approx)).toBeGreaterThan(0.999);
    }
  });

  it('handles the all-zero vector without producing NaN', () => {
    const { codes, scale } = quantizeInt8(new Float32Array(DIM));
    const approx = dequantizeInt8(codes, scale);
    for (const x of approx) expect(Number.isFinite(x)).toBe(true);
  });

  it('rejects a decode with the wrong code length (bound-checked)', () => {
    expect(() => dequantizeInt8(new Int8Array(DIM - 1), 0.01)).toThrow();
  });

  it('rejects a decode with a non-finite scale (fails closed)', () => {
    expect(() => dequantizeInt8(new Int8Array(DIM), Number.NaN)).toThrow();
    expect(() => dequantizeInt8(new Int8Array(DIM), Number.POSITIVE_INFINITY)).toThrow();
  });
});
