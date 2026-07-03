// @kgpacks/embeddings — int8 vector quantization codec (WS2 spike).
//
// The full CVE pack's largest component is its fp32 embedding matrix (~343k × 768
// ≈ 2.1 GiB). Quantizing each vector to int8 shrinks that ~4× (~525 MiB). This is
// the deterministic per-vector codec; adopting it as a pack format is GATED on a
// recall-parity check (see docs/pack-quantization.md and scripts/spike-quantize.mjs).
// It never mutates existing fp32 packs.

/** Embedding dimensionality (BGE base). The decoder is bound-checked against it. */
export const QUANT_DIM = 768;

/**
 * Quantizes an fp32 vector to per-vector-scaled int8:
 *   `scale = max(|v|) / 127`, `codes[i] = round(v[i] / scale)` clamped to [-128,127].
 * The all-zero vector maps to `scale = 0` with all-zero codes (no NaN). Returns the
 * int8 codes plus the scale needed to dequantize.
 */
export function quantizeInt8(vector: Float32Array): { codes: Int8Array; scale: number } {
  let max = 0;
  for (let i = 0; i < vector.length; i++) {
    const abs = Math.abs(vector[i]);
    if (abs > max) max = abs;
  }
  const scale = max / 127;
  const codes = new Int8Array(vector.length);
  if (scale > 0) {
    for (let i = 0; i < vector.length; i++) {
      const q = Math.round(vector[i] / scale);
      codes[i] = q > 127 ? 127 : q < -128 ? -128 : q;
    }
  }
  return { codes, scale };
}

/**
 * Dequantizes int8 codes back to an fp32 vector (`v'[i] = codes[i] * scale`). Fails
 * CLOSED rather than producing garbage: it rejects a wrong code length (must be
 * {@link QUANT_DIM}) and a non-finite scale (NaN / ±Infinity).
 */
export function dequantizeInt8(codes: Int8Array, scale: number): Float32Array {
  if (codes.length !== QUANT_DIM) {
    throw new Error(`dequantizeInt8: expected ${QUANT_DIM} codes, got ${codes.length}`);
  }
  if (!Number.isFinite(scale)) {
    throw new Error('dequantizeInt8: scale must be a finite number');
  }
  const out = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    out[i] = codes[i] * scale;
  }
  return out;
}
