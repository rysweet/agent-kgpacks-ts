# Vector quantization (int8)

The full CVE pack's biggest component is its embedding matrix: ~343k × 768
**fp32** vectors ≈ **2.1 GiB**. Quantizing those vectors to **int8** shrinks that
component by ~4× (to ~525 MiB) — a large cut to the ~4.8 GiB pack and its download.

Quantization is **adoption-gated on a recall-parity check**: it ships **only if**
the smaller pack retrieves as well as the fp32 pack, measured by the eval harness.
Otherwise it stays a documented spike, disabled by default, and fp32 packs are
unchanged.

> **Overriding invariant.** A `pack_format: 1` (fp32) pack must return
> **byte-identical retrieval** before and after this feature lands. Quantization is
> a new, opt-in pack format — it never alters existing packs.

## How int8 quantization works

Each 768-dim fp32 vector is mapped to 768 **int8** values with a per-vector
(row-wise) linear scale, storing the scale (and zero-point) alongside so the vector
can be dequantized for scoring:

```
q[i] = round( v[i] / scale )         scale = max(|v|) / 127
v'[i] ≈ q[i] * scale                  (dequantized at query time)
```

Per-vector scaling keeps the relative error small for cosine similarity (the metric
retrieval uses). The `@kgpacks/embeddings` package exposes the codec:

```ts
import { quantizeInt8, dequantizeInt8 } from '@kgpacks/embeddings';

const { codes, scale } = quantizeInt8(vector); // Int8Array(768) + number
const approx = dequantizeInt8(codes, scale); // Float32Array(768)
```

The decoder is **bound-checked**: it rejects a wrong length (must be 768) and any
non-finite input (NaN/Inf), failing closed rather than producing garbage vectors.

## Running the spike & parity check

`scripts/spike-quantize.mjs` quantizes an existing fp32 pack's Chunk embeddings to
int8 and reports the **LLM-free retrieval-parity signals** that gate adoption
(cosine parity, hit@k parity, and the size delta):

```bash
# Quantize the installed CVE pack's vectors and measure retrieval parity
node scripts/spike-quantize.mjs --pack cve --packs-dir ~/.local/share/kgpacks
# …or point at a DB directly, capping the sample for speed:
node scripts/spike-quantize.mjs --db data/packs/cve/pack.db --limit 5000 --k 10
```

It reports, as JSON:

- **cosine parity** — mean/min `cosine(fp32, dequantized-int8)` per vector.
- **hit@k parity** — for a sampled query set, the mean top-_k_ overlap between
  retrieving over the fp32 corpus and over the int8 corpus (a retrieval-level,
  LLM-free signal).
- **size delta** — the embedding-byte shrink (~4×).

The **accuracy** arm of the gate (`Δaccuracy` from `wikigr pack eval`, see
[docs/cve-eval.md](cve-eval.md)) needs a **live judge** and is not run by this
script; it must be measured on a real `pack_format: 2` build before the default
flips.

### Spike results (measured)

Run over a real BGE-embedded pack (300 chunk vectors, k=10, 50 sampled queries):

```jsonc
{
  "vectors": 300,
  "dim": 768,
  "k": 10,
  "cosineMean": 0.999892,
  "cosineMin": 0.99986, // ≫ the 0.999 retrieval-parity bar
  "hitAtK": 0.996, // 99.6% top-10 overlap fp32 ↔ int8
  "shrinkFactor": 3.98, // ~4× smaller embeddings
  "retrievalParityHolds": true,
  "accuracyDelta": null, // requires a live-judge eval run
}
```

**Retrieval parity holds** decisively (cosine ≫ 0.999, hit@10 = 0.996, ~4× shrink).
The remaining gate is the LLM-judged accuracy delta, which requires a live eval on a
`pack_format: 2` build. Until that is measured, **quantization stays disabled**: the
codec ships (unused by the default build), `--quantize` is not enabled, and only
fp32 (`pack_format: 1`) packs are published.

### The adoption gate

int8 is adopted (the `--quantize` build flag becomes the recommended default) **only
if both** hold:

| Gate             | Threshold                                                          |
| ---------------- | ------------------------------------------------------------------ |
| Accuracy delta   | `Δaccuracy ≥ −0.02` (int8 accuracy within 2 points of fp32)        |
| Retrieval parity | top-_k_ **hit@k parity** holds (result sets substantially overlap) |

If either fails, quantization remains **disabled**: the spike script and this
document record the measured numbers, the `--quantize` flag stays off by default,
and only fp32 packs are published.

## The quantized pack format (`pack_format: 2`)

When adopted, a quantized pack is a **new, additive format** — it does not mutate
the fp32 layout:

- The manifest gains `"pack_format": 2` (fp32 packs are implicitly/​explicitly
  `pack_format: 1`). Only quantization bumps the format number.
- Embeddings are stored as an `embedding_q8` column (int8 codes + per-row scale)
  instead of the fp32 `embedding` column; the HNSW vector index is built over the
  int8 representation.
- Readers dispatch on `pack_format`: a `pack_format: 1` pack is read exactly as
  today (unchanged code path), a `pack_format: 2` pack dequantizes at scoring time.

## Building a quantized pack

> **Status: not yet enabled (spike only).** The `--quantize` build flag and the
> `pack_format: 2` reader/writer below are the **adoption plan** for when the
> accuracy gate is confirmed. They are **not implemented in this build** — the
> retrieval-parity spike passed, but the LLM-judged accuracy delta has not yet been
> measured on a live eval, so the default (and only) format stays fp32
> (`pack_format: 1`). This section documents the intended shape.

Once the gate passes, `--quantize` is added to the build (it stays **off by
default** so a plain build still produces a `pack_format: 1` fp32 pack):

```bash
# fp32 pack (default, pack_format: 1) — unchanged
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db

# int8 pack (pack_format: 2) — ~4× smaller embeddings, gated on parity
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db --quantize
```

| Flag         | Default | Meaning                                                                                                                        |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--quantize` | off     | Store int8 (`pack_format: 2`) embeddings + int8 HNSW index. Requires int8 vector-index support; errors clearly if unavailable. |

## Requirements & fallback

int8 storage needs the vector engine to build/search an **int8 HNSW** index. The
spike **probes** for that support; if it is unavailable, `--quantize` fails with a
clear message and the feature stays disabled — fp32 remains the only published
format. This document and `scripts/spike-quantize.mjs` are the record of what was
measured and why.

## Related docs

- [docs/cve-eval.md](cve-eval.md) — the eval harness the parity gate uses.
- [docs/pack-versioning.md](pack-versioning.md) — `pack_format` in the manifest.
- [docs/using-the-cve-pack.md](using-the-cve-pack.md) — installing & querying packs.
