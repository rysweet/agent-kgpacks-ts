#!/usr/bin/env node
// int8 quantization SPIKE + retrieval-parity check (WS2, docs/pack-quantization.md).
//
// Quantizes an existing fp32 pack's Chunk embeddings to int8, then measures the
// LLM-free retrieval-parity signals that gate adoption:
//   • cosine parity   — mean/min cosine(fp32, dequantized-int8) per vector;
//   • hit@k parity     — top-k overlap between retrieving over the fp32 vs the int8
//                        corpus for a sampled query set (the retrieval-level gate);
//   • size delta       — the embedding-byte shrink (~4×).
//
// The ACCURACY gate (Δaccuracy from `wikigr pack eval`, needing a live judge) is NOT
// run here; this reports the deterministic retrieval signals and the adoption
// decision. A quantized pack format (`pack_format: 2`) ships only once BOTH gates
// pass — until then --quantize stays disabled and fp32 packs are unchanged.
//
//   node scripts/spike-quantize.mjs --pack cve --packs-dir ~/.local/share/kgpacks
//   node scripts/spike-quantize.mjs --db data/packs/cve/pack.db [--limit 5000] [--k 10]
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { Database } from '../packages/db/dist/index.js';
import { quantizeInt8, dequantizeInt8, QUANT_DIM } from '../packages/embeddings/dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const pack = opt('--pack');
const packsDir = opt('--packs-dir', join(process.cwd(), 'data', 'packs'));
const dbPath = opt('--db', pack ? join(packsDir, pack, 'pack.db') : undefined);
const limit = Math.max(1, Number(opt('--limit', '5000')) || 5000);
const k = Math.max(1, Number(opt('--k', '10')) || 10);
const querySample = Math.max(1, Number(opt('--queries', '50')) || 50);
const parityThreshold = Number(opt('--parity-threshold', '0.98')) || 0.98;

if (!dbPath) {
  console.error(
    'usage: spike-quantize.mjs (--pack <name> [--packs-dir dir] | --db <path>) [--limit N] [--k N] [--queries N]',
  );
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`pack DB not found: ${dbPath}`);
  process.exit(2);
}

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const round = (x, p) => Math.round(x * 10 ** p) / 10 ** p;

const db = new Database(dbPath);
const conn = db.connect();
const rows = await conn.run(`MATCH (c:Chunk) RETURN c.embedding AS emb LIMIT ${limit}`);
conn.close();
db.close();

if (rows.length === 0) {
  console.error('no Chunk embeddings found in the pack');
  process.exit(1);
}

// fp32 corpus + its int8 round-trip (the candidate quantized representation).
const fp32 = rows.map((r) => Float32Array.from(r.emb));
const approx = fp32.map((v) => {
  const { codes, scale } = quantizeInt8(v);
  return dequantizeInt8(codes, scale);
});

// Per-vector cosine parity.
let cosSum = 0;
let cosMin = 1;
for (let i = 0; i < fp32.length; i++) {
  const c = cosine(fp32[i], approx[i]);
  cosSum += c;
  if (c < cosMin) cosMin = c;
}
const cosineMean = cosSum / fp32.length;

// hit@k parity: retrieve top-k over the fp32 vs the int8 corpus for a sampled query
// set and measure the mean overlap fraction.
const topK = (query, corpus) =>
  corpus
    .map((v, idx) => ({ idx, s: cosine(query, v) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .slice(0, k)
    .map((x) => x.idx);
const step = Math.max(1, Math.floor(fp32.length / querySample));
let overlapSum = 0;
let queries = 0;
for (let i = 0; i < fp32.length; i += step) {
  const fp32Top = new Set(topK(fp32[i], fp32));
  const int8Top = topK(fp32[i], approx);
  overlapSum += int8Top.filter((x) => fp32Top.has(x)).length / k;
  queries++;
}
const hitAtK = overlapSum / queries;

const fp32Bytes = fp32.length * QUANT_DIM * 4;
const int8Bytes = fp32.length * (QUANT_DIM * 1 + 4); // int8 codes + one fp32 scale/vector
const retrievalParityHolds = hitAtK >= parityThreshold;

const report = {
  db: dbPath,
  vectors: fp32.length,
  dim: QUANT_DIM,
  k,
  queries,
  cosineMean: round(cosineMean, 6),
  cosineMin: round(cosMin, 6),
  hitAtK: round(hitAtK, 4),
  parityThreshold,
  retrievalParityHolds,
  sizeFp32Bytes: fp32Bytes,
  sizeInt8Bytes: int8Bytes,
  shrinkFactor: round(fp32Bytes / int8Bytes, 2),
  accuracyDelta: null,
  decision: retrievalParityHolds
    ? 'retrieval parity holds; enabling --quantize still requires a live-judge `wikigr pack eval` to confirm Δaccuracy ≥ −0.02. Until then --quantize stays DISABLED.'
    : 'retrieval parity FAILED; quantization stays DISABLED.',
};
console.log(JSON.stringify(report, null, 2));
