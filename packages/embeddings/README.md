# @kgpacks/embeddings

Local, Python-free **BGE text embeddings** for the agent-kgpacks retrieval stack.
This package wraps [Transformers.js](https://www.npmjs.com/package/@huggingface/transformers)
(`@huggingface/transformers`, ONNX Runtime) to turn text into the **exact** 768-dimensional
vectors the knowledge packs are indexed against — reproducing the Python
sentence-transformers `BAAI/bge-base-en-v1.5` embeddings closely enough to clear the
**retrieval-parity gate** (cosine ≥ 0.999) defined in [docs/PLAN.md](../../docs/PLAN.md).

> The embedder ships with the
> validated **Spike B** configuration and a frozen golden-fixture parity test. This is
> the **document/query embedding** slice only. The **cross-encoder reranker** (Spike D,
> `Xenova/ms-marco-MiniLM-L-12-v2`) is also slated for this package per
> [docs/PLAN.md](../../docs/PLAN.md) and lands separately; the retrieval _pipeline_ that
> consumes both (vector search, graph reranker, synthesis) lives in `@kgpacks/query`. See
> [docs/monorepo.md](../../docs/monorepo.md) for the workspace layout and conventions.

## What it does

- `generate(texts)` — embeds **documents** (passages). **No prefix** is added.
- `generateQuery(queries)` — embeds **search queries**. The BGE query prefix
  `Represent this sentence for searching relevant passages: ` is prepended to **every
  query, and only to queries**.

Both return order-preserving arrays of L2-normalized **`Float32Array`** vectors, one per
input, each **768-dimensional**.

> **Why two methods?** BGE is an asymmetric retrieval model: queries are embedded with an
> instruction prefix while documents are embedded raw. Mixing them up (prefixing
> documents, or omitting it on queries) silently degrades recall. The two-method API makes
> the correct usage the only easy usage — there is no `addPrefix` flag to get wrong.

## Validated configuration (Spike B)

Every value below is **locked**. It is the configuration that Spike B validated at
**cosine = 1.000000** against the Python oracle, and it is **not
configurable** at runtime — there are no constructor options that change the model,
pooling, normalization, dimensionality, or prefix.

| Setting        | Value                                                       | Notes                                                                       |
| -------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| TS model       | `Xenova/bge-base-en-v1.5`                                   | ONNX build consumed by Transformers.js.                                     |
| Python oracle  | `BAAI/bge-base-en-v1.5`                                     | sentence-transformers reference the fixtures were frozen from.              |
| Pooling        | `cls`                                                       | Take the `[CLS]` token embedding (not mean pooling).                        |
| Normalization  | L2 (`normalize: true`)                                      | Output is unit-norm (`‖v‖ = 1.0`), matching the model's `Normalize` module. |
| Dimensionality | `768`                                                       | Every returned vector has exactly 768 elements.                             |
| Query prefix   | `Represent this sentence for searching relevant passages: ` | **Queries only.** Documents get no prefix.                                  |
| Output element | `Float32Array`                                              | `float32` precision preserved; never widened to JS `number[]`.              |

> **Do not deviate.** Changing pooling, skipping normalization, or moving the prefix
> breaks stored-vector parity and the embeddings will no longer align with the indexed
> packs. The parity gate exists precisely to fail the build if this drifts.

## Installation

`@kgpacks/embeddings` is an internal workspace package; consume it from other
`@kgpacks/*` packages via a workspace dependency:

```jsonc
// packages/<consumer>/package.json
{
  "dependencies": {
    "@kgpacks/embeddings": "workspace:*",
  },
}
```

From the repo root:

```bash
pnpm install
pnpm --filter @kgpacks/embeddings build
pnpm --filter @kgpacks/embeddings test   # runs the parity gate (needs network — see below)
```

The only runtime dependency is `@huggingface/transformers` (ONNX Runtime ships as a
platform-prebuilt binary; **no C/C++ toolchain is required**). The dependency is pinned
through the committed `pnpm-lock.yaml` and installed with `--frozen-lockfile` in CI.

## Quick start

```ts
import { BgeEmbedder } from '@kgpacks/embeddings';

const embedder = new BgeEmbedder();

// Documents — embedded raw, no prefix.
const docVecs = await embedder.generate([
  'Knowledge graphs store entities and relationships.',
  'Vector search retrieves nearest neighbors by cosine similarity.',
]);
docVecs.length; // 2
docVecs[0] instanceof Float32Array; // true
docVecs[0].length; // 768

// Queries — the BGE query prefix is added internally.
const queryVecs = await embedder.generateQuery(['What is a knowledge graph?']);
queryVecs[0].length; // 768

// Rank documents against the query by cosine similarity (vectors are unit-norm,
// so cosine == dot product).
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
const scores = docVecs.map((d) => dot(queryVecs[0], d));
// scores[0] (the knowledge-graph passage) is the highest.
```

### Storing vectors in a pack

The vectors are the exact width and format LadybugDB expects for a cosine HNSW index
(`FLOAT[768]`). Pass them straight through `@kgpacks/db`:

```ts
import { Database } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';

const embedder = new BgeEmbedder();
const [vec] = await embedder.generate(['Knowledge graphs store entities and relationships.']);

const db = new Database();
const conn = db.connect();
await conn.loadExtension('vector');
await conn.run('CREATE NODE TABLE Doc(id INT64, embedding FLOAT[768], PRIMARY KEY(id))');
await conn.run('CREATE (:Doc {id: $id, embedding: $vec})', {
  id: 1,
  vec: Array.from(vec), // FLOAT[768] column accepts a JS number[] of length 768
});
```

## API reference

### `class BgeEmbedder`

The public embedder. Constructing one is cheap and does **not** load the model — the
underlying Transformers.js pipeline is created lazily on first use and **shared across all
instances and both methods** (see [Lazy loading](#lazy-loading--reuse)). You can construct
a fresh `BgeEmbedder` per call site without paying for a second model load.

#### `new BgeEmbedder()`

Takes no arguments. The model id, pooling, normalization, dimensionality, and query prefix
are fixed constants — there is intentionally nothing to configure.

#### `embedder.generate(texts: string[]): Promise<Float32Array[]>`

Embeds **documents / passages**. Texts are passed to the model **verbatim — no prefix**.

| Parameter | Type       | Description                              |
| --------- | ---------- | ---------------------------------------- |
| `texts`   | `string[]` | Document texts to embed, in input order. |

Returns a promise resolving to a `Float32Array[]` of the **same length and order** as
`texts`. Each vector is 768-dimensional and L2-normalized. An **empty input array returns
`[]`** without loading the model or running inference.

#### `embedder.generateQuery(queries: string[]): Promise<Float32Array[]>`

Embeds **search queries**. Each query is internally prefixed with
`Represent this sentence for searching relevant passages: ` before encoding; the prefix is
an internal constant and is never exposed or configurable.

| Parameter | Type       | Description                           |
| --------- | ---------- | ------------------------------------- |
| `queries` | `string[]` | Query texts to embed, in input order. |

Returns a promise resolving to a `Float32Array[]` matching the input length and order.
Each vector is 768-dimensional and L2-normalized. As with `generate`, an **empty input
array returns `[]`** without loading the model or running inference.

> The two methods produce **different vectors for the same input string** — that
> asymmetry is intentional and is what makes BGE retrieval work. Embed documents with
> `generate` and queries with `generateQuery`; never the reverse.

### Output contract

- **Type:** `Float32Array` (float32 precision preserved end to end).
- **Length:** every vector has exactly **768** elements.
- **Norm:** unit length (`‖v‖ ≈ 1.0`), so cosine similarity equals the dot product.
- **Order:** strictly preserved — `result[i]` corresponds to `input[i]`.
- **Batching:** the whole input array is encoded in a **single** pipeline call, then the
  flat tensor is sliced into per-text rows. Order is guaranteed by construction.

## Lazy loading & reuse

The Transformers.js feature-extraction pipeline is expensive to build (it downloads and
initializes the ONNX model). The package therefore:

1. **Defers** model construction until the first `generate` / `generateQuery` call.
2. **Memoizes** the construction promise at module scope, so concurrent first calls share
   one in-flight load and every later call reuses the warm pipeline.
3. Shares that single pipeline across **all `BgeEmbedder` instances** in the process.

Net effect: the model is downloaded and loaded **once per process**, no matter how many
embedders you create or calls you make.

## Parity gate (the reason this package exists)

Retrieval only works if the TS query vectors land in the same neighborhood as the Python
vectors the packs were indexed with. This package enforces that with a **frozen golden
fixture** and a vitest parity test.

- **Fixture:** [`test/fixtures/bge-golden.json`](test/fixtures/bge-golden.json) — frozen
  Python sentence-transformers `BAAI/bge-base-en-v1.5` vectors (CLS-pooled, L2-normalized),
  generated by the Spike B oracle. Fields:

  | Field                                                    | Meaning                                              |
  | -------------------------------------------------------- | ---------------------------------------------------- |
  | `docs`                                                   | 3 document strings.                                  |
  | `queries`                                                | 2 query strings.                                     |
  | `doc_emb`                                                | `3 × 768` golden document vectors (no prefix).       |
  | `query_emb`                                              | `2 × 768` golden query vectors (BGE prefix applied). |
  | `dim`                                                    | `768`.                                               |
  | `model` / `ts_model` / `config` / `source` / `generated` | provenance stamps.                                   |

  > **The fixture is read-only.** It is the parity oracle's signed output. Never
  > regenerate or overwrite it as part of making the test pass — a change here must be a
  > deliberate, reviewed commit. Accidentally re-freezing it would silently disable the
  > gate.

- **Assertion:** the test embeds `docs` via `generate` and `queries` via `generateQuery`,
  then asserts, **for every document and every query**:

  - the vector length is exactly `768`, and
  - the cosine similarity to the corresponding golden vector is **≥ 0.999**.

  Cosine is computed as a guarded dot product (divided by both norms) so the check is
  robust even though both sides are already unit-norm.

```ts
// packages/embeddings/test/parity.test.ts (shape of the committed test)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BgeEmbedder } from '../src/index.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/bge-golden.json', import.meta.url), 'utf8'),
);

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('BGE embedding parity', () => {
  const embedder = new BgeEmbedder();

  it('matches the golden document vectors (cosine >= 0.999)', async () => {
    const vecs = await embedder.generate(golden.docs);
    vecs.forEach((v, i) => {
      expect(v.length).toBe(768);
      expect(cosine(v, golden.doc_emb[i])).toBeGreaterThanOrEqual(0.999);
    });
  });

  it('matches the golden query vectors (cosine >= 0.999)', async () => {
    const vecs = await embedder.generateQuery(golden.queries);
    vecs.forEach((v, i) => {
      expect(v.length).toBe(768);
      expect(cosine(v, golden.query_emb[i])).toBeGreaterThanOrEqual(0.999);
    });
  });
});
```

### Network requirement & timeout

The parity test performs **real inference**, so on first run it downloads the
`Xenova/bge-base-en-v1.5` ONNX weights from the Hugging Face Hub over HTTPS. Consequently:

- **The test requires outbound network access** the first time the model is fetched: the
  CI job that runs it must allow egress to the Hugging Face Hub. Subsequent runs reuse the
  Transformers.js on-disk cache and need no network.
- The package ships its own [`vitest.config.ts`](vitest.config.ts) raising `testTimeout`
  to **120000 ms** to cover that one-time download plus first inference — the default 5 s
  is not enough.

Run it directly:

```bash
pnpm --filter @kgpacks/embeddings test
# or as part of the whole workspace:
pnpm -r test
```

## Security & privacy

- **No text egress.** Embedding runs **locally** via ONNX Runtime. The **only** outbound
  network call is the one-time Hugging Face model-weights download on first use. No text
  you embed is ever sent to a remote embedding API, and there is no telemetry.
- **Supply chain.** `@huggingface/transformers` is pinned via the committed lockfile and
  installed with `--frozen-lockfile`; pnpm's default-deny on install lifecycle scripts is
  kept. The only script that may need allow-listing is `onnxruntime-node`'s native
  postinstall, and only if a clean `--frozen-lockfile` install proves it necessary — the
  allow-list is never broadened beyond that.
- **Model integrity.** Because the parity gate compares against frozen reference vectors,
  a tampered or wrong model fails the build — the ≥ 0.999 check doubles as a model-integrity
  check.
- **No injectable config.** Model id, pooling, normalization, and prefix are hard-coded
  constants; nothing about the model is derived from caller input.

## Performance notes

- **One model load per process** (see [Lazy loading](#lazy-loading--reuse)); after warm-up,
  calls are just inference.
- **Batch within a call.** Each method encodes its whole input array in a single pipeline
  invocation — prefer one call with many texts over many calls with one text.
- **Unbounded batches can OOM.** The package does **not** impose a hidden batch cap;
  memory scales with `texts.length × 768 × 4 bytes` plus ONNX intermediates. Chunk very
  large inputs at the call site if needed.

## Troubleshooting

| Symptom                                    | Likely cause                                                             | Fix                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Parity test times out at ~5 s              | A runner/config not using the package's `vitest.config.ts`.              | Run via `pnpm --filter @kgpacks/embeddings test`; ensure `testTimeout: 120000`.          |
| Test fails with a download / network error | No outbound HTTPS access to fetch the model on first run.                | Allow egress for the test job (CI has it); subsequent runs use the local cache.          |
| Cosine just under `0.999`                  | A deviation from the validated config (pooling/normalize/prefix).        | Restore the locked Spike B config: `pooling:'cls'`, `normalize:true`, query-only prefix. |
| Vectors look wrong for queries             | Queries embedded with `generate` (no prefix) instead of `generateQuery`. | Use `generateQuery` for queries, `generate` for documents.                               |
| `ERR_MODULE_NOT_FOUND` for a local import  | Missing `.js` extension on a relative import under `NodeNext`.           | Import compiled paths, e.g. `'../src/index.js'`.                                         |

## See also

- [docs/PLAN.md](../../docs/PLAN.md) — the port plan, Spike B (embedding pooling parity),
  and the retrieval-parity acceptance criteria this gate enforces.
- [docs/packages/db.md](../../docs/packages/db.md) — `@kgpacks/db`, where these vectors are
  stored and queried (cosine HNSW index).
- [docs/monorepo.md](../../docs/monorepo.md) — workspace layout, scripts, and conventions.
