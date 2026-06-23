# `@kgpacks/query` — ENHANCEMENTS layer (Phase 1)

Five **optional** retrieval-quality stages that sit on top of the
[`@kgpacks/query`](../README.md) CORE read path (vector + hybrid retrieval +
Cypher safety). Each stage is **off by default** and is enabled per query with an
`enable*` flag, so a retriever with no flags set behaves **byte-for-byte** like
the CORE retriever documented in the package README.

The five stages, ported from the upstream `rysweet/agent-kgpacks` Python read path
(the reranker, cross-encoder, multi-document synthesis, few-shot, and Cypher-RAG
modules of `wikigr/agent`):

| Stage               | Module                   | Enable flag          | What it does                                                                              |
| ------------------- | ------------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| Graph reranker      | `reranker.ts`            | `enableReranker`     | Re-orders candidates using `LINKS_TO` graph proximity (deterministic neighbour boost).    |
| Cross-encoder       | `cross-encoder.ts`       | `enableCrossEncoder` | Re-scores `(query, passage)` pairs with `Xenova/ms-marco-MiniLM-L-12-v2` (Spike D, fp32). |
| Cypher-RAG          | `cypher-rag.ts`          | `enableCypherRag`    | Asks the agent for Cypher, validates it **fail-closed**, runs it, merges the rows.        |
| Few-shot selection  | `few-shot.ts`            | `enableFewshot`      | Picks the top-`n` most similar exemplars (BGE cosine) to seed the synthesis prompt.       |
| Multi-doc synthesis | `multi-doc-synthesis.ts` | `enableMultidoc`     | Combines multiple retrieved sections into one cited answer via `@kgpacks/agent`.          |

> **Status: implemented (Phase 1 — query enhancements slice).** This document is
> the **API contract** the implementation satisfies; it is the enhancements
> analogue of [docs/packages/db.md](../../../docs/packages/db.md) and
> [docs/packages/agent.md](../../../docs/packages/agent.md). The cross-encoder
> stage is **parity-gated** against a committed Python golden fixture (Spike D);
> the reranker, few-shot, and Cypher-RAG stages are **deterministic** and tested
> with fakes/mocks (no network).

> **Built on top of the merged packages — nothing is reimplemented.** Vector and
> graph access go through [`@kgpacks/db`](../../../docs/packages/db.md); query and
> example embeddings through [`@kgpacks/embeddings`](../../embeddings/README.md);
> answer synthesis and Cypher generation through
> [`@kgpacks/agent`](../../../docs/packages/agent.md); and the CORE
> `vectorRetrieve` / `hybridRetrieve` / `validateCypher` primitives through this
> package's own CORE surface.

---

## Table of contents

- [Pipeline overview](#pipeline-overview)
- [The flags-off invariant](#the-flags-off-invariant)
- [Installation & configuration](#installation--configuration)
- [Quick start](#quick-start)
- [API reference](#api-reference)
  - [`createRetriever` — extended construction options](#createretriever--extended-construction-options)
  - [`RetrieveOptions` — the five enable flags](#retrieveoptions--the-five-enable-flags)
  - [`retriever.retrieveAndSynthesize`](#retrieverretrieveandsynthesize)
  - [Graph reranker — `graphRerank`](#graph-reranker--graphrerank)
  - [Cross-encoder — `CrossEncoder`](#cross-encoder--crossencoder)
  - [Few-shot selection — `selectFewShot`](#few-shot-selection--selectfewshot)
  - [Cypher-RAG — `cypherRagRetrieve`](#cypher-rag--cypherragretrieve)
  - [Multi-doc synthesis — `synthesizeFromResults`](#multi-doc-synthesis--synthesizefromresults)
  - [Structural contracts](#structural-contracts)
- [Cross-encoder parity gate (Spike D)](#cross-encoder-parity-gate-spike-d)
- [Testing](#testing)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Pipeline overview

Stages run in a **fixed, documented order**. Each is a pure transform over the
candidate list (synthesis excepted), so a disabled stage is a pass-through:

```
                       ┌─────────────────────────────────────────────────────┐
 query ───▶ retrieve() │ vector | hybrid   (CORE — always runs)               │
                       │   │                                                   │
                       │   ▼  enableCypherRag                                  │
                       │ cypherGen(agent) ─▶ validateCypher ─▶ conn.run        │
                       │   │  (merge + dedupe by id into candidate set)        │
                       │   ▼  enableReranker                                   │
                       │ graphRerank  (LINKS_TO neighbour boost, re-sort)      │
                       │   │                                                   │
                       │   ▼  enableCrossEncoder                               │
                       │ CrossEncoder.rerank  (ms-marco logits, re-sort)       │
                       │   │                                                   │
                       └───┼───────────────────────────────────────────────────┘
                           ▼  RetrieverResult[]   ◀── retrieve() returns here

   retrieveAndSynthesize() continues:
                           │  enableFewshot
                           ▼ selectFewShot  (BGE cosine top-n exemplars)
                           │  enableMultidoc
                           ▼ agent.synthesizeAnswer  ─▶ { results, synthesis }
```

| Order | Stage               | Flag                 | Runs in                              |
| ----- | ------------------- | -------------------- | ------------------------------------ |
| 0     | vector / hybrid     | _(always)_           | `retrieve` & `retrieveAndSynthesize` |
| 1     | Cypher-RAG          | `enableCypherRag`    | `retrieve` & `retrieveAndSynthesize` |
| 2     | Graph reranker      | `enableReranker`     | `retrieve` & `retrieveAndSynthesize` |
| 3     | Cross-encoder       | `enableCrossEncoder` | `retrieve` & `retrieveAndSynthesize` |
| 4     | Few-shot selection  | `enableFewshot`      | `retrieveAndSynthesize` only         |
| 5     | Multi-doc synthesis | `enableMultidoc`     | `retrieveAndSynthesize` only         |

Stages **1–3** reshape the `RetrieverResult[]` candidate list and are honoured by
both `retrieve()` and `retrieveAndSynthesize()`. Stages **4–5** only affect the
synthesized answer, so they are honoured **only** by `retrieveAndSynthesize()`;
passing `enableFewshot`/`enableMultidoc` to `retrieve()` is a documented no-op
(its return type never changes — see [the invariant](#the-flags-off-invariant)).

## The flags-off invariant

> **With every `enable*` flag unset (the default), `retrieve()` returns exactly
> what the CORE pipeline returns** — same ids, same scores, same order. The
> enhancements layer adds surface area but never changes CORE behaviour unless you
> opt in. The package's existing CORE tests are unchanged and continue to pass.

This invariant is enforced by a dedicated test (`test/flags-off.test.ts`) that
runs `retrieve()` with no options against a fixture pack and asserts the result is
deep-equal to the CORE `vectorRetrieve` / `hybridRetrieve` output.

## Installation & configuration

`@kgpacks/query` is an internal workspace package. The enhancements layer adds two
runtime dependencies, declared in `packages/query/package.json`:

```jsonc
// packages/query/package.json
{
  "dependencies": {
    "@kgpacks/db": "workspace:*",
    "@kgpacks/embeddings": "workspace:*",
    "@kgpacks/agent": "workspace:*", //          ← added: synthesis + Cypher generation
    "@huggingface/transformers": "^3.8.1", //    ← added: cross-encoder (ONNX)
  },
}
```

The TypeScript project references gain `@kgpacks/agent` so cross-package types
resolve under composite builds:

```jsonc
// packages/query/tsconfig.json
{
  "references": [{ "path": "../db" }, { "path": "../embeddings" }, { "path": "../agent" }],
}
```

From the repo root:

```bash
pnpm install
pnpm -r build      # TS project references resolve @kgpacks/agent for query
pnpm -r test       # CORE + enhancements suites (cross-encoder downloads its model once)
```

> The cross-encoder model (`Xenova/ms-marco-MiniLM-L-12-v2`) is downloaded from
> the Hugging Face Hub the first time it is used, exactly like the BGE embedder.
> The package's [`vitest.config.ts`](../vitest.config.ts) already raises the test
> and hook timeouts to **120 s** to cover that one-time cold-cache download.

## Quick start

```ts
import { Database } from '@kgpacks/db';
import { BgeEmbedder } from '@kgpacks/embeddings';
import { CopilotAgent } from '@kgpacks/agent';
import { createRetriever } from '@kgpacks/query';

const db = new Database('pack.lbug');
const conn = db.connect();
await conn.loadExtension('vector');

const agent = new CopilotAgent();
await agent.start();

// Heavyweight resources are constructed ONCE and shared across queries.
const retriever = createRetriever(conn, {
  embedder: new BgeEmbedder(), // reused for vector retrieval AND few-shot similarity
  agent, // used by multi-doc synthesis and Cypher-RAG
  fewShotExamples: [
    { id: 'ex:1', text: 'Q: What is HNSW? A: A navigable small-world graph index.' },
    { id: 'ex:2', text: 'Q: What is cosine similarity? A: Dot product of unit vectors.' },
  ],
});

// CORE behaviour — no flags, byte-identical to the CORE retriever.
const baseline = await retriever.retrieve('what is quantum entanglement?', { k: 5 });

// Opt in to the candidate-list stages, per query.
const reranked = await retriever.retrieve('quantum entanglement', {
  k: 5,
  mode: 'hybrid',
  enableReranker: true, //     graph proximity re-rank
  enableCrossEncoder: true, // ms-marco relevance re-score
});

// Full enhanced pipeline + a synthesized, cited answer.
const { results, synthesis } = await retriever.retrieveAndSynthesize('how does HNSW search work?', {
  k: 8,
  enableCypherRag: true,
  enableReranker: true,
  enableCrossEncoder: true,
  enableFewshot: true,
  enableMultidoc: true,
});

console.log(synthesis.answer); // cited prose grounded in `results`
console.log(synthesis.metadata.citedIds); // e.g. ['12', '7'] (RetrieverResult ids are node primary keys)

await agent.stop();
conn.close();
db.close();
```

## API reference

### `createRetriever` — extended construction options

Heavyweight, reusable resources are supplied **once** at construction. The CORE
fields (`embedder`, `nodeTable`, `vectorIndex`, `stopWords`) are unchanged; the
enhancements layer adds the following optional fields to `CreateRetrieverOptions`:

| Field             | Type               | Default                                | Used by                         |
| ----------------- | ------------------ | -------------------------------------- | ------------------------------- |
| `embedder`        | `Embedder`         | fresh `BgeEmbedder`                    | vector retrieval **+** few-shot |
| `agent`           | `QueryAgent`       | _unset_                                | multi-doc synthesis, Cypher-RAG |
| `crossEncoder`    | `CrossEncoder`     | lazy singleton `createCrossEncoder()`  | cross-encoder stage             |
| `fewShotExamples` | `FewShotExample[]` | `[]`                                   | few-shot stage                  |
| `fewShotN`        | `number`           | `3`                                    | few-shot stage (top-n selected) |
| `reranker`        | `RerankerOptions`  | `{ alpha: 0.5, seedK: 5, maxHops: 1 }` | graph reranker stage            |

```ts
export interface CreateRetrieverOptions {
  // ── CORE (unchanged) ──────────────────────────────────────────────────────
  embedder?: Embedder; // CORE type, unchanged; the default BgeEmbedder also satisfies FewShotEmbedder
  nodeTable?: string; // default 'Section'
  vectorIndex?: string; // default 'embedding_idx'
  stopWords?: ReadonlySet<string>;

  // ── ENHANCEMENTS (all optional, all static) ──────────────────────────────
  /** Agent used by multi-doc synthesis (`synthesizeAnswer`) and Cypher-RAG (Cypher
   *  generation via the `cypherGeneratorFromAgent` adapter — `CopilotAgent` has no
   *  `generateCypher` of its own). A `CopilotAgent` satisfies the synthesis half
   *  directly; see {@link QueryAgent}. Required only when those stages are enabled. */
  agent?: QueryAgent;
  /** Cross-encoder reranker. Defaults to a lazily-constructed singleton over
   *  `Xenova/ms-marco-MiniLM-L-12-v2` (fp32). Inject a fake in tests. */
  crossEncoder?: CrossEncoder;
  /** Few-shot exemplar corpus. Selection is a no-op when empty. */
  fewShotExamples?: FewShotExample[];
  /** Number of exemplars the few-shot stage selects (top-n by BGE cosine). Default 3. */
  fewShotN?: number;
  /** Graph-reranker tuning. */
  reranker?: RerankerOptions;
}
```

> **Resource lifetime.** The `agent` is **not** owned by the retriever: you call
> `agent.start()` / `agent.stop()` yourself. The `crossEncoder` and `embedder`
> load their ONNX models lazily on first use and are shared across every query, so
> construct the retriever once and reuse it.

> **Fail-closed on missing resources.** Enabling a stage without its resource
> throws a `QueryError` at call time — e.g. `enableMultidoc: true` with no `agent`
> throws `QueryError('multi-doc synthesis requires an agent')`, and
> `enableFewshot: true` with a query-only embedder lacking `generate` throws
> `QueryError('few-shot selection requires a document embedder')`. The flag is
> never silently ignored. (The default `BgeEmbedder` provides `generate`, so
> few-shot works out of the box; the throw only guards an injected, query-only
> `Embedder`.)

### `RetrieveOptions` — the five enable flags

The per-query `RetrieveOptions` gains five booleans, **all defaulting to `false`**.
The CORE fields (`k`, `mode`, `weights`) are unchanged.

```ts
export interface RetrieveOptions {
  // ── CORE (unchanged) ──
  k?: number; // default 10
  mode?: RetrieveMode; // 'vector' (default) | 'hybrid'
  weights?: HybridWeights; // hybrid-only

  // ── ENHANCEMENTS (default false) ──
  /** Stage 1: augment candidates with validated agent-generated Cypher rows. */
  enableCypherRag?: boolean;
  /** Stage 2: re-rank candidates by LINKS_TO graph proximity. */
  enableReranker?: boolean;
  /** Stage 3: re-score candidates with the ms-marco cross-encoder. */
  enableCrossEncoder?: boolean;
  /** Stage 4: select few-shot exemplars (synthesis only; no-op in retrieve). */
  enableFewshot?: boolean;
  /** Stage 5: synthesize a multi-doc answer (synthesis only; no-op in retrieve). */
  enableMultidoc?: boolean;
}
```

`retrieve(query, opts)` honours `enableCypherRag`, `enableReranker`, and
`enableCrossEncoder` and returns the reshaped `RetrieverResult[]`. It **ignores**
`enableFewshot` / `enableMultidoc` (those only affect synthesis) so its return
type and the flags-off invariant are preserved.

### `retriever.retrieveAndSynthesize`

The enhancements layer **extends** the CORE [`Retriever`](../README.md) interface —
which exposes only `retrieve` — with a second method, `retrieveAndSynthesize`, that
runs the full pipeline and returns a synthesized answer alongside the candidate
list. `retrieve`'s signature is unchanged, so the flags-off invariant holds:

```ts
export interface Retriever {
  /** CORE: vector/hybrid retrieval, honouring the candidate-list flags (stages 0–3). */
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrieverResult[]>;
  /** ENHANCEMENTS: full pipeline + synthesized answer (adds stages 4–5). */
  retrieveAndSynthesize(
    query: string,
    opts?: RetrieveOptions,
  ): Promise<RetrieveAndSynthesizeResult>;
}

export interface RetrieveAndSynthesizeResult {
  /** The candidate list AFTER stages 0–3, exactly as `retrieve()` would return. */
  results: RetrieverResult[];
  /** The synthesized answer, its cited ids, and token usage for the call. */
  synthesis: SynthesisResult; // re-exported from @kgpacks/agent
  /** The exemplars chosen by the few-shot stage (empty when disabled). */
  exemplars: FewShotExample[];
}
```

The full pipeline:

1. Runs `retrieve(query, opts)` → `results` (stages 0–3).
2. If `enableFewshot`, runs [`selectFewShot`](#few-shot-selection--selectfewshot)
   over the configured `fewShotExamples`, selecting the top-`fewShotN` (default 3)
   → `exemplars` (else `[]`). This requires the construction `embedder` to expose
   `generate` (a [`FewShotEmbedder`](#structural-contracts)); a query-only embedder
   throws `QueryError` (fail-closed). The default `BgeEmbedder` satisfies it.
3. Maps `results` to `ContextChunk[]` (`{ id, text: content }`). If
   `enableMultidoc` is **false**, only the single top-ranked result is passed as
   context (degenerate single-doc grounding); if **true**, the full list is passed.
4. Calls `agent.synthesizeAnswer({ question, context })`, augmenting `question`
   with a short demonstrations preamble rendered from `exemplars` when few-shot is
   enabled. Exemplars are **not** part of `synthesis.metadata.citedIds`.
5. Returns `{ results, synthesis, exemplars }`.

> `retrieveAndSynthesize` **requires** `agent` on the retriever; calling it without
> one throws `QueryError`. `retrieve()` is unaffected and never needs an agent.

### Graph reranker — `graphRerank`

Deterministic re-ranking that boosts candidates which are **graph neighbours** of
the strongest candidates, mirroring the upstream reranker module's proximity
model and this package's `hybrid.ts` `LINKS_TO` accumulation.

```ts
export interface RerankerOptions {
  /** Boost coefficient. Default 0.5. */
  alpha?: number;
  /** Number of top candidates treated as traversal seeds. Default 5. */
  seedK?: number;
  /** Graph hops to expand from each seed. Default (and current max) 1. */
  maxHops?: number;
  /** Node table for the LINKS_TO traversal. Defaults to the retriever's `nodeTable`. */
  nodeTable?: string;
}

export function graphRerank(
  conn: Connection,
  candidates: RetrieverResult[],
  options?: RerankerOptions,
): Promise<RetrieverResult[]>;
```

**Algorithm (fully deterministic):**

1. Take the top-`seedK` candidates (by incoming score) as **seeds**.
2. For each seed, query its 1-hop `LINKS_TO` neighbours (both directions) via
   `conn.run`, bounded by `maxHops`.
3. For every neighbour that is **already in the candidate set**, add a decayed
   boost: `boost = alpha · seedScore / (1 + hopDistance)`. Neighbours not already
   among the candidates are ignored (the reranker never introduces new nodes).
4. Re-sort by `originalScore + Σ boosts`, **descending**.
5. **Tie-break** by original rank, then by `id` (lexicographic) — so equal scores
   always produce a stable, reproducible order.

The boosted value is written back to `result.score`. Disabling the stage (the
default) leaves the candidate list untouched.

```ts
import { graphRerank } from '@kgpacks/query';

const reranked = await graphRerank(conn, candidates, { alpha: 0.5, seedK: 5, maxHops: 1 });
```

### Cross-encoder — `CrossEncoder`

A relevance reranker that scores `(query, passage)` pairs with the **validated
Spike D** configuration: `Xenova/ms-marco-MiniLM-L-12-v2` loaded with
`AutoModelForSequenceClassification` at dtype **`fp32`**. Spike D validated this
against the Python `cross-encoder/ms-marco-MiniLM-L-12-v2` at **max |diff| =
0.0000** with identical ranking — so this stage is **exact parity**, not merely
structural.

> **Package placement.** `docs/PLAN.md` (Default Stack) nominally lists the
> cross-encoder under `@kgpacks/embeddings`. This slice keeps it in
> `@kgpacks/query` (`cross-encoder.ts`) because it is a query-time re-ranking
> concern and the work is scoped to `packages/query/`; it reuses the
> `@huggingface/transformers` runtime already pulled in transitively by
> `@kgpacks/embeddings`. If a future slice consolidates model loaders, this is the
> natural seam to move — the public `CrossEncoder` contract stays the same.

```ts
export interface CrossEncoder {
  /**
   * Raw relevance logits for each passage against `query`, in input order.
   * One forward pass over `AutoModelForSequenceClassification` (fp32); higher =
   * more relevant. These are the same logits the Python cross-encoder's
   * `.predict()` returns.
   */
  score(query: string, passages: string[]): Promise<number[]>;

  /**
   * Convenience: scores `candidates` against `query`, writes each logit back to
   * `result.score`, and returns the list sorted by logit descending. Tie-break is
   * stable (original order). Optionally truncates to `opts.topN`.
   */
  rerank(
    query: string,
    candidates: RetrieverResult[],
    opts?: { topN?: number },
  ): Promise<RetrieverResult[]>;
}

/** Lazily constructs the singleton cross-encoder (load-once per process). */
export function createCrossEncoder(): CrossEncoder;
```

| Setting   | Value                                | Notes                                                        |
| --------- | ------------------------------------ | ------------------------------------------------------------ |
| Model     | `Xenova/ms-marco-MiniLM-L-12-v2`     | Full ONNX build (fp32 + quantized; we use fp32).             |
| Task head | `AutoModelForSequenceClassification` | Single-logit relevance head — **not** feature extraction.    |
| dtype     | `fp32`                               | The validated Spike D dtype; quantized builds are not used.  |
| Tokenizer | model default                        | Truncates long passages per the model's max sequence length. |
| Loading   | lazy memoized singleton              | Replicates the BGE embedder's load-once-per-process pattern. |

```ts
import { createCrossEncoder } from '@kgpacks/query';

const ce = createCrossEncoder();
const logits = await ce.score('what is hnsw?', [
  'HNSW is a navigable small-world graph index.',
  'Bananas are a good source of potassium.',
]);
// logits[0] >> logits[1]
```

> **Why scores change after this stage.** The cross-encoder **replaces** the prior
> (cosine/hybrid) `score` with its own relevance logit, because re-ranking
> supersedes the earlier signal. Logits are unbounded and may be negative; do not
> mix them with cosine scores from an earlier stage.

### Few-shot selection — `selectFewShot`

Selects the `n` exemplars most similar to the query, by **BGE cosine similarity**,
to seed the synthesis prompt. Uses the same `@kgpacks/embeddings` `BgeEmbedder`
configuration as retrieval (Spike B: `Xenova/bge-base-en-v1.5`, CLS pooling,
L2-normalized).

```ts
export interface FewShotExample {
  /** Stable id used for deterministic tie-breaking and traceability. */
  id: string;
  /** The exemplar text (e.g. a Q/A demonstration) embedded for similarity. */
  text: string;
}

export function selectFewShot(
  embedder: FewShotEmbedder,
  query: string,
  examples: FewShotExample[],
  n: number,
): Promise<FewShotExample[]>;
```

**Behaviour:**

- Embeds the query with `embedder.generateQuery([query])` and the example texts
  with `embedder.generate(texts)` (asymmetric BGE: prefix on the query only).
- Ranks examples by cosine similarity (vectors are unit-norm ⇒ dot product),
  **descending**.
- **Tie-break** by `id` (lexicographic) for a deterministic, reproducible order.
- Returns the top-`n`. An **empty corpus** (or `n ≤ 0`) returns `[]` without
  loading the model.

```ts
import { selectFewShot } from '@kgpacks/query';

const top2 = await selectFewShot(embedder, 'how does HNSW search work?', examples, 2);
```

### Cypher-RAG — `cypherRagRetrieve`

Asks the agent to generate a Cypher query for the question, validates it through
the CORE [`validateCypher`](../README.md#cypher-safety) gate **fail-closed**, runs
the validated query, and maps the rows into `RetrieverResult[]`. It **augments**
(never replaces) the safe vector path.

```ts
export function cypherRagRetrieve(
  conn: Connection,
  generator: CypherGenerator,
  query: string,
  opts?: { k?: number; nodeTable?: string },
): Promise<RetrieverResult[]>;
```

**Flow (each step fails closed):**

1. `cypher = await generator.generateCypher(query)`.
2. `validateCypher(cypher)` — throws `CypherValidationError` if the query is not a
   read-only `MATCH`/`CALL`, contains a write/DDL keyword, or uses a
   variable-length path. The agent's output is **untrusted input** and gets the
   full CORE safety treatment.
3. `rows = await conn.run(cypher)` — the validated query is executed as-is; any
   user-derived values the generator embeds must already be literals, since this
   path runs agent-authored Cypher directly.
4. Rows are mapped to `RetrieverResult` (`id`, `content`, and a fixed Cypher-RAG
   `score`) and **merged + deduped by `id`** with the vector candidates. On a
   score tie, **validated Cypher rows take precedence**.

When wired into the pipeline (`enableCypherRag: true`), the merged set flows into
the reranker/cross-encoder stages. On validation failure the stage **throws** —
the retriever does not silently fall back, matching the mandatory safety gate.

> **Agent adapter.** A `CopilotAgent` has **no** `generateCypher` method (see
> [`@kgpacks/agent`](../../../docs/packages/agent.md), whose operations are
> synthesis, query-expansion, multi-query, and seed-article ID). When
> `enableCypherRag` is set on the retriever, it adapts the configured `agent` with
> [`cypherGeneratorFromAgent`](#structural-contracts) automatically. The
> lower-level `cypherRagRetrieve` takes a `CypherGenerator` directly, so callers
> wrap the agent themselves, as below.

```ts
import { cypherRagRetrieve, cypherGeneratorFromAgent, CypherValidationError } from '@kgpacks/query';

try {
  const rows = await cypherRagRetrieve(
    conn,
    cypherGeneratorFromAgent(agent),
    'articles linking to "HNSW"',
    { k: 10 },
  );
} catch (err) {
  if (err instanceof CypherValidationError) {
    // The agent proposed a non-read-only query — rejected by design.
  }
}
```

### Multi-doc synthesis — `synthesizeFromResults`

Combines multiple retrieved sections into a single grounded, cited answer by
delegating to [`@kgpacks/agent`](../../../docs/packages/agent.md)'s
`synthesizeAnswer`. No model calls are reimplemented here — this is a thin adapter
from `RetrieverResult[]` to the agent's `SynthesisRequest`.

```ts
export function synthesizeFromResults(
  agent: QueryAgent,
  question: string,
  results: RetrieverResult[],
  opts?: { exemplars?: FewShotExample[]; multidoc?: boolean; timeoutMs?: number },
): Promise<SynthesisResult>;
```

- Maps each `RetrieverResult` to a `ContextChunk` (`{ id, text: content }`).
- `multidoc: false` passes only the top result as context; `true` (the wired
  default) passes the full list.
- `exemplars` are rendered into a short demonstrations preamble appended to
  `question`; they are **not** added to `citedIds`.
- Returns the agent's `SynthesisResult` unchanged (`answer`, `metadata.citedIds`,
  `usage`).

Most callers use the [`retrieveAndSynthesize`](#retrieverretrieveandsynthesize)
facade rather than calling this directly.

### Structural contracts

The enhancements layer depends on **minimal structural interfaces**, not concrete
classes, so every stage is injectable and testable offline.

```ts
/** Document-and-query embedder. `BgeEmbedder` satisfies it. Extends the CORE
 *  `Embedder` (query-only) with `generate` for embedding example texts. The
 *  retriever is *constructed* with the CORE `Embedder`; few-shot additionally
 *  requires this richer shape and fails closed otherwise. */
export interface FewShotEmbedder extends Embedder {
  generate(texts: string[]): Promise<Float32Array[]>;
}

/** Synthesis capability — satisfied directly by `CopilotAgent`. */
export interface SynthesisAgent {
  synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult>;
}

/** Cypher-generation capability used by the Cypher-RAG stage. */
export interface CypherGenerator {
  generateCypher(question: string): Promise<string>;
}

/** The combined agent contract the retriever accepts. A `CopilotAgent` provides
 *  `synthesizeAnswer`; `generateCypher` is provided by `cypherGeneratorFromAgent`
 *  (a thin prompt adapter exported by this package) when Cypher-RAG is enabled. */
export interface QueryAgent extends SynthesisAgent, Partial<CypherGenerator> {}

/** Adapts a `CopilotAgent` (or any `SynthesisAgent`) into a `CypherGenerator` by
 *  prompting it for a single read-only Cypher statement. */
export function cypherGeneratorFromAgent(agent: SynthesisAgent): CypherGenerator;
```

> **Why structural?** Tests pass a `RecordingConnection`, a fake embedder, and a
> mock agent/`Transport` — so the reranker, few-shot, and Cypher-RAG suites run
> with **zero network** and are fully deterministic. Only the cross-encoder parity
> test loads a real model (see below).

#### Public exports

The enhancements surface is added to `src/index.ts` alongside the CORE exports:

```ts
// values
export { graphRerank } from './reranker.js';
export { createCrossEncoder } from './cross-encoder.js';
export { selectFewShot } from './few-shot.js';
export { cypherRagRetrieve } from './cypher-rag.js';
export { synthesizeFromResults } from './multi-doc-synthesis.js';
export { cypherGeneratorFromAgent } from './cypher-rag.js';

// types
export type {
  RerankerOptions,
  CrossEncoder,
  FewShotExample,
  FewShotEmbedder,
  QueryAgent,
  SynthesisAgent,
  CypherGenerator,
  RetrieveAndSynthesizeResult,
} from './types.js';

// re-exported from @kgpacks/agent for caller convenience
export type { SynthesisRequest, SynthesisResult, ContextChunk } from '@kgpacks/agent';
```

`test/index.test.ts` is extended to lock this surface (and to keep asserting the
package does **not** leak its internal locked multipliers).

## Cross-encoder parity gate (Spike D)

The cross-encoder is the one enhancements stage with an **exact** Python parity
contract, so it ships a frozen golden fixture and a vitest parity test — the
cross-encoder analogue of the BGE embedding parity gate.

- **Fixture:** `test/fixtures/cross-encoder-golden.json` — a small set of
  `(query, passage)` pairs and the **Python oracle logits** from
  `cross-encoder/ms-marco-MiniLM-L-12-v2`, frozen by the Spike D oracle (validated
  max |diff| = 0.0000). The fixture is **read-only**; it is the oracle and must
  never be regenerated to make the test pass.

  | Field                                     | Meaning                                                           |
  | ----------------------------------------- | ----------------------------------------------------------------- |
  | `query`                                   | The query string.                                                 |
  | `passages`                                | The candidate passage strings, in a fixed order.                  |
  | `scores`                                  | Python-oracle relevance logits, aligned 1:1 with `passages`.      |
  | `ranking`                                 | The passage indices sorted by `scores` descending (golden order). |
  | `model` / `ts_model` / `dtype` / `source` | provenance stamps.                                                |

- **Assertion** (`test/cross-encoder-parity.test.ts`): loads the **real**
  `Xenova/ms-marco-MiniLM-L-12-v2` model (`AutoModelForSequenceClassification`,
  fp32) via `createCrossEncoder()`, scores the fixture pairs, and asserts:
  1. the produced ranking **equals** the golden ranking **exactly**, and
  2. each score is within `tol = 1e-3` of the golden logit (ONNX fp32 numerics).

```ts
// packages/query/test/cross-encoder-parity.test.ts (shape of the committed test)
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCrossEncoder } from '../src/index.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/cross-encoder-golden.json', import.meta.url), 'utf8'),
) as { query: string; passages: string[]; scores: number[]; ranking: number[] };

const TOL = 1e-3;

describe('@kgpacks/query — cross-encoder parity gate (Spike D golden logits)', () => {
  let scores: number[];

  beforeAll(async () => {
    scores = await createCrossEncoder().score(golden.query, golden.passages);
  });

  it('reproduces the Python logits within 1e-3', () => {
    golden.scores.forEach((expected, i) => {
      expect(Math.abs(scores[i] - expected), `passage[${i}]`).toBeLessThanOrEqual(TOL);
    });
  });

  it('produces the exact golden ranking', () => {
    const ranking = scores
      .map((s, i) => [s, i] as const)
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i);
    expect(ranking).toEqual(golden.ranking);
  });
});
```

> **Network & timeout.** Like the BGE parity test, this performs real inference
> and downloads the ONNX weights on first run; the package `vitest.config.ts`
> already raises the timeout to **120 s**. CI has outbound network by design
> (fail-closed). Subsequent runs reuse the Transformers.js on-disk cache.

## Testing

| Suite                          | Network                   | Determinism             | What it locks                                                        |
| ------------------------------ | ------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `cross-encoder-parity.test.ts` | yes (model)               | exact (≤1e-3 + ranking) | fp32 ms-marco logits == Python oracle.                               |
| `reranker.test.ts`             | no                        | exact                   | `LINKS_TO` boost, seed/decay math, stable tie-break.                 |
| `few-shot.test.ts`             | no (fake embedder)        | exact                   | top-`n` BGE-cosine selection, id tie-break, empty-corpus no-op.      |
| `cypher-rag.test.ts`           | no (mock agent/transport) | exact                   | validate-then-run, fail-closed rejection, merge/dedupe precedence.   |
| `multi-doc-synthesis.test.ts`  | no (mock agent)           | structural              | `RetrieverResult[]` → `SynthesisRequest` mapping, exemplar preamble. |
| `flags-off.test.ts`            | no                        | exact                   | the [flags-off invariant](#the-flags-off-invariant).                 |
| `index.test.ts` (extended)     | no                        | exact                   | public export surface; no internal-constant leakage.                 |

The reranker, few-shot, Cypher-RAG, and synthesis suites use **fakes/mocks** — a
`RecordingConnection` over `@kgpacks/db`, a deterministic fake embedder, and a
mock `Transport` / agent — so they run offline. Run everything with:

```bash
pnpm --filter @kgpacks/query test
# or the whole workspace:
pnpm -r test
```

## Security model

- **Cypher-RAG is fail-closed.** Every agent-generated Cypher statement passes
  through the CORE `validateCypher` allow-list (read-only `MATCH`/`CALL`, no
  write/DDL keyword, no variable-length path) **before** it touches the database.
  A rejected query throws `CypherValidationError`; there is no bypass and no silent
  fallback. The agent's output is treated as untrusted input.
- **CORE path is unchanged.** With flags off, no user text is ever routed into
  Cypher — the CORE pipeline still runs only fixed, parameter-bound queries.
- **Local inference, no text egress.** The cross-encoder runs locally via ONNX
  Runtime; the only outbound call is the one-time model-weights download. Few-shot
  embedding is likewise local (BGE/ONNX).
- **Agent secrets stay in the agent.** BYOK provider credentials live in
  `@kgpacks/agent` and are never surfaced through the retriever, results, or
  errors.
- **Python-free.** No Python is shipped or invoked. The upstream reference modules
  are consulted only as a documented parity contract; this package contains no
  `.py` files and no Python tooling, and `pnpm check:no-python` passes.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                    | Fix                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `QueryError: multi-doc synthesis requires an agent`      | `enableMultidoc`/`retrieveAndSynthesize` used with no `agent`.                  | Pass `agent` to `createRetriever` and call `agent.start()` first.                        |
| `CypherValidationError` from a Cypher-RAG call           | The agent proposed a non-read-only or variable-length-path query.               | Expected, by design. Tighten the generation prompt; never relax `validateCypher`.        |
| Cross-encoder parity test times out at ~5 s              | A runner not using the package `vitest.config.ts`.                              | Run via `pnpm --filter @kgpacks/query test` (`testTimeout: 120000`).                     |
| Cross-encoder parity off by more than `1e-3`             | Wrong dtype/model (quantized build, or feature-extraction head).                | Use `AutoModelForSequenceClassification` + `dtype: 'fp32'` on `ms-marco-MiniLM-L-12-v2`. |
| Reranker/few-shot output differs between runs            | A tie was resolved non-deterministically upstream.                              | The stages tie-break by `id`; ensure candidate `id`s are stable strings.                 |
| `retrieve()` results changed after enabling enhancements | Expected — flags reshape candidates. CORE behaviour returns with all flags off. | Verify the [flags-off invariant](#the-flags-off-invariant) holds with no options.        |
| `ERR_MODULE_NOT_FOUND` for a local import                | Missing `.js` extension on a relative import under `NodeNext`.                  | Import compiled paths, e.g. `'../src/index.js'`.                                         |

## See also

- [packages/query/README.md](../README.md) — the CORE retrieval pipeline (vector,
  hybrid, Cypher safety) these stages build on.
- [docs/packages/agent.md](../../../docs/packages/agent.md) — `@kgpacks/agent`:
  `synthesizeAnswer` (multi-doc synthesis) and the injectable `Transport` seam.
- [packages/embeddings/README.md](../../embeddings/README.md) — `BgeEmbedder`
  (Spike B), reused for few-shot similarity, and the parity-gate pattern the
  cross-encoder test mirrors.
- [docs/packages/db.md](../../../docs/packages/db.md) — `@kgpacks/db`: the
  `Connection` the reranker and Cypher-RAG stages query.
- [docs/PLAN.md](../../../docs/PLAN.md) — Spike B (BGE) and Spike D (cross-encoder)
  validation, and the Phase 1 enhancements scope.
