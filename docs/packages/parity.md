# `@kgpacks/parity` — the dev-time parity harness

The **parity harness** pins the agent-kgpacks **TypeScript** port to the behavior
of the original **Python** implementation. It diffs the pipeline **stage by
stage** against committed **golden fixtures**, so a regression is localized to a
single stage — query embedding, retrieval, reranking, or final answer — instead
of being guessed from a single end-to-end score (see
[docs/PLAN.md](../PLAN.md) → _Parity Methodology_).

```
query  ->  query-embedding  ->  retrieved-ids  ->  reranked-ids  ->  final-answer
```

> **Dev/CI tooling, never shipped.** The harness lives under the top-level
> `parity/` directory and is **outside every runtime package's dependency
> graph**. Python is permitted here **only** as a development-time oracle and
> must never be importable or invokable by shipped code. This boundary is
> machine-enforced — see [The dev-only boundary](#the-dev-only-boundary).

The harness has two cooperating halves that communicate **only through committed
JSON**:

| Half                        | Path             | Language   | Role                                                               |
| --------------------------- | ---------------- | ---------- | ------------------------------------------------------------------ |
| **`@kgpacks/parity`**       | `parity/diff/`   | TypeScript | Loads a golden fixture and diffs actual pipeline output against it |
| **golden-fixture exporter** | `parity/oracle/` | Python     | Emits the committed golden fixtures with provenance stamps         |

The TypeScript side never imports or spawns Python; the Python side never imports
TypeScript. The JSON fixture is the contract between them.

---

## Contents

- [Why stage-localizing parity?](#why-stage-localizing-parity)
- [The dev-only boundary](#the-dev-only-boundary)
- [Layout](#layout)
- [Quick start](#quick-start)
- [The golden fixture (`schemaVersion: 1`)](#the-golden-fixture-schemaversion-1)
- [Stage comparison contract](#stage-comparison-contract)
- [TypeScript API (`@kgpacks/parity`)](#typescript-api-kgpacksparity)
- [Configuration reference](#configuration-reference)
- [The Python oracle (`parity/oracle`)](#the-python-oracle-parityoracle)
- [Tutorials](#tutorials)
- [Gating checks](#gating-checks)
- [Scope](#scope)

---

## Why stage-localizing parity?

A single end-to-end answer-quality score tells you _that_ the port regressed but
not _where_. The agent-kgpacks pipeline has four observable stages, and a fault
in an early stage cascades into every later one. The harness therefore freezes
the oracle's output at **each** stage in the golden fixture and evaluates **all
four** stages (no short-circuit), with stage-appropriate equality semantics. The
report names the **earliest** diverged stage so you fix the root cause, not a
symptom.

```
   actual pipeline output                golden fixture
   ┌─────────────────────┐               ┌─────────────────────┐
   │ query-embedding[]   │  ── cosine ─▶ │ queryEmbedding.vector│
   │ retrievedIds[]      │  ── ordered ▶ │ retrievedIds         │
   │ rerankedIds[]       │  ── ordered ▶ │ rerankedIds          │
   │ finalAnswer{…}      │  ── struct ─▶ │ finalAnswer          │
   └─────────────────────┘               └─────────────────────┘
                       │
                       ▼
                 ParityReport { pass, firstDivergedStage, stages }
```

---

## The dev-only boundary

**This is not a shipped runtime package.** The guarantee is that no runtime
package (`packages/*`) ever depends on, imports, or invokes Python.

- **Communication is JSON-only.** `@kgpacks/parity` reads a committed `*.json`
  fixture; the Python oracle writes one. Neither imports the other.
- **The harness lives outside every package graph.** `parity/diff` is a private
  workspace member with **zero external dependencies**; `parity/oracle` is plain
  Python that is _not_ a workspace package at all.
- **The boundary is enforced in CI.** `scripts/check-no-python.mjs`
  (root `pnpm check:no-python`) scans `packages/*` for Python-flavored
  dependencies or source that shells out to Python and **fails closed** on any
  violation. Because everything Python lives under `parity/`, the scan stays
  green trivially. **CI must run `pnpm check:no-python`** to assert runtime
  packages remain Python-free.

> If you ever need the harness to import from a runtime package (e.g. the real TS
> pipeline), import the **published TS surface** of that package — never the
> other direction, and never Python.

---

## Layout

```
parity/
├── README.md                         # in-tree dev README (boundary + regen)
├── diff/                             # @kgpacks/parity — TS workspace package (dev-only, zero deps)
│   ├── package.json                  # private; build / typecheck / test scripts
│   ├── tsconfig.json                 # extends ../../tsconfig.base.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts                  # public barrel
│   │   ├── types.ts                  # fixture & report shapes, STAGE_ORDER
│   │   ├── cosine.ts                 # cosineSimilarity
│   │   ├── load.ts                   # loadFixture / assertGoldenFixture
│   │   └── compare.ts                # compareStages
│   └── test/
│       ├── parity.test.ts            # behavioral spec (vitest)
│       └── fixtures/
│           └── sample-golden.json    # tiny synthetic golden fixture
└── oracle/                           # Python exporter (NOT a workspace package)
    ├── export_fixtures.py            # stdlib-only stub that emits golden fixtures
    └── requirements.txt              # pinned REAL-mode deps (stub needs none)
```

The workspace is registered by a single glob in `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'parity/*'
```

pnpm only treats directories with a `package.json` as members, so it picks up
`parity/diff` and ignores `parity/oracle` (which has none).

---

## Quick start

```bash
corepack enable                              # activate the pinned pnpm@9
pnpm install                                 # link the workspace (no new external deps)

# Build + test just the harness
pnpm --filter @kgpacks/parity build
pnpm --filter @kgpacks/parity test

# Regenerate the sample golden fixture (stdlib-only, no pip install)
python3 parity/oracle/export_fixtures.py \
  && pnpm exec prettier --write parity/diff/test/fixtures/sample-golden.json
```

The harness also participates in the repo-wide `pnpm -r build`, `pnpm -r test`,
`pnpm typecheck`, `pnpm lint`, and `pnpm format:check`.

---

## The golden fixture (`schemaVersion: 1`)

Golden fixtures are committed JSON with **camelCase** keys. Each fixture captures
one **case** (a query + its run configuration) and the oracle's expected output
at every stage, plus a **provenance** stamp that makes a stale fixture obvious.

```jsonc
{
  "schemaVersion": 1,
  "provenance": {
    "gitSha": "0000000000000000000000000000000000000000", // git rev-parse HEAD of the oracle checkout
    "generatedAt": "1970-01-01T00:00:00Z", // ISO-8601 UTC
    "oracle": "agent-kgpacks-python (stub)", // who produced this fixture
    "models": {
      "queryEmbedding": "BAAI/bge-base-en-v1.5",
      "reranker": "cross-encoder/ms-marco-MiniLM-L-6-v2",
      "answer": "stub-deterministic",
    },
    "bindingVersion": "@ladybugdb/core@0.17.1", // native binding version
    "storageVersion": "kgpack-storage@1", // on-disk pack/storage version
  },
  "case": {
    "id": "sample-1",
    "query": "What is a knowledge pack?",
    "config": { "topK": 5, "cosineThreshold": 0.999, "seed": 42 },
  },
  "stages": {
    "queryEmbedding": {
      "dim": 8,
      "vector": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    },
    "retrievedIds": ["n1", "n2", "n3", "n4", "n5"],
    "rerankedIds": ["n3", "n1", "n2"],
    "finalAnswer": {
      "citations": ["n3", "n1"], // unordered set
      "topK": ["n3", "n1", "n2"], // ordered list
      "seed": 42,
      "text": "A knowledge pack is a portable, queryable graph of documents and their relationships.",
    },
  },
}
```

### Field reference

| Path                           | Type     | Compared? | Notes                                                                                              |
| ------------------------------ | -------- | --------- | -------------------------------------------------------------------------------------------------- |
| `schemaVersion`                | `1`      | —         | Validated on load; any other value is rejected.                                                    |
| `provenance.gitSha`            | string   | —         | `git rev-parse HEAD` of the oracle checkout.                                                       |
| `provenance.generatedAt`       | string   | —         | ISO-8601 UTC timestamp.                                                                            |
| `provenance.oracle`            | string   | —         | Human-readable oracle id (`… (stub)` for the bundled exporter).                                    |
| `provenance.models.*`          | string   | —         | Embedder / reranker / answer model ids.                                                            |
| `provenance.bindingVersion`    | string   | —         | Native binding (`@ladybugdb/core@x.y.z`).                                                          |
| `provenance.storageVersion`    | string   | —         | On-disk storage/pack version.                                                                      |
| `case.id`                      | string   | —         | Fixture/case identifier.                                                                           |
| `case.query`                   | string   | —         | The query text the stages were produced for.                                                       |
| `case.config.topK`             | number   | —         | Candidate count the oracle used.                                                                   |
| `case.config.cosineThreshold`  | number   | **input** | Default embedding-match threshold (overridable per compare call).                                  |
| `case.config.seed`             | number   | —         | Run seed (the answer's own `seed` is the compared value).                                          |
| `stages.queryEmbedding.dim`    | number   | —         | Recorded vector dimensionality; **not** read by the harness (the comparator uses `vector.length`). |
| `stages.queryEmbedding.vector` | number[] | **yes**   | Cosine-compared against the actual embedding.                                                      |
| `stages.retrievedIds`          | string[] | **yes**   | Exact ordered equality.                                                                            |
| `stages.rerankedIds`           | string[] | **yes**   | Exact ordered equality.                                                                            |
| `stages.finalAnswer.citations` | string[] | **yes**   | Set equality (order-independent).                                                                  |
| `stages.finalAnswer.topK`      | string[] | **yes**   | Ordered equality.                                                                                  |
| `stages.finalAnswer.seed`      | number   | **yes**   | Exact equality.                                                                                    |
| `stages.finalAnswer.text`      | string   | **no**    | Recorded for context; deliberately **ignored** by the comparator.                                  |

> Fixtures are **tiny synthetic JSON** by design — the committed sample uses an
> 8-dimensional embedding and five nodes. **No scraped corpora, no binaries, no
> LFS.**

---

## Stage comparison contract

`compareStages` evaluates all four stages and never short-circuits, so the report
localizes **every** divergence.

| Stage             | Equality semantics                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `query-embedding` | dimensions must match **and** `cosine(actual, golden) ≥ cosineThreshold` (default `0.999`) |
| `retrieved-ids`   | exact **ordered** array equality                                                           |
| `reranked-ids`    | exact **ordered** array equality                                                           |
| `final-answer`    | `citations` **set-equal**, `topK` **ordered-equal**, `seed` **exact**; `text` **ignored**  |

- **`firstDivergedStage`** is the earliest diverged stage in the canonical
  `STAGE_ORDER` (`query-embedding` → `retrieved-ids` → `reranked-ids` →
  `final-answer`), or `null` when everything matches.
- **`pass`** is `true` only when **every** stage matches.
- A **dimension mismatch** on the embedding diverges that stage with a descriptive
  `detail` — it never throws.

> **Why is `text` ignored?** The TypeScript port synthesizes its final answer with
> the GitHub Copilot SDK, a different provider than the Python oracle, so
> exact-text parity is impossible. The harness instead asserts **structural**
> answer parity (which nodes were cited, in what top-k order, under which seed),
> giving high confidence in the retrieval stack while tolerating provider-specific
> wording.

---

## TypeScript API (`@kgpacks/parity`)

Import everything from the package barrel. The package is native ESM.

```ts
import {
  loadFixture,
  assertGoldenFixture,
  cosineSimilarity,
  compareStages,
  STAGE_ORDER,
} from '@kgpacks/parity';

import type {
  GoldenFixture,
  PipelineOutput,
  ParityReport,
  StageName,
  StageResult,
  StageStatus,
  CompareOptions,
  FinalAnswer,
  FixtureCase,
  FixtureCaseConfig,
  FixtureStages,
  QueryEmbeddingStage,
  Provenance,
} from '@kgpacks/parity';
```

### `loadFixture(path): GoldenFixture`

Reads a golden fixture from disk and validates it.

```ts
function loadFixture(path: string | URL): GoldenFixture;
```

- Accepts a filesystem path **or** a `URL` (e.g. `new URL('./fixtures/x.json',
import.meta.url)` for ESM-relative loading).
- Reads the file as UTF-8, `JSON.parse`s it, and runs it through
  `assertGoldenFixture`.
- **Throws** on read/parse errors or schema-validation failures.

```ts
const golden = loadFixture(new URL('./fixtures/sample-golden.json', import.meta.url));
```

### `assertGoldenFixture(value): GoldenFixture`

Validates an already-parsed value and narrows its type.

```ts
function assertGoldenFixture(value: unknown): GoldenFixture;
```

Validation is intentionally **shallow** — it pins exactly what the comparator
reads, so a malformed or stale fixture fails loudly at load time rather than
producing a misleading report. It throws when:

- the value is not a plain object;
- `schemaVersion !== 1`;
- `stages.queryEmbedding.vector` is not a `number[]`;
- `stages.retrievedIds` / `stages.rerankedIds` is not a `string[]`;
- `stages.finalAnswer` lacks `citations: string[]`, `topK: string[]`, or a numeric
  `seed`;
- `case.config` is missing, or `case.config.cosineThreshold` is not a number.

```ts
assertGoldenFixture({ schemaVersion: 2 }); // throws: unsupported … schemaVersion: 2 (expected 1)
assertGoldenFixture(null); // throws: invalid golden fixture: expected a JSON object
```

### `cosineSimilarity(a, b): number`

Guarded cosine similarity used by the embedding stage.

```ts
function cosineSimilarity(a: readonly number[], b: readonly number[]): number;
```

- Divides by the L2 norms, so it is correct even when operands are not unit
  length (and is therefore **scale-invariant**: `cos([1,2,3], [2,4,6]) === 1`).
- Returns `0` when either operand has zero norm (the compare layer treats that as
  a divergence).
- **Throws** on a dimension mismatch — but the compare layer checks dimensions
  first and never calls it with mismatched lengths.

```ts
cosineSimilarity([1, 2, 3], [1, 2, 3]); // 1
cosineSimilarity([1, 0], [0, 1]); // 0
cosineSimilarity([1, 2], [1, 2, 3]); // throws: dimension mismatch: 2 vs 3
```

### `compareStages(actual, golden, opts?): ParityReport`

The core diff. Compares a pipeline's actual output against a golden fixture and
returns a fully populated, localized report.

```ts
function compareStages(
  actual: PipelineOutput,
  golden: GoldenFixture,
  opts?: CompareOptions,
): ParityReport;
```

The effective embedding threshold is resolved as:

```
opts.cosineThreshold  ??  golden.case.config.cosineThreshold  ??  0.999
```

```ts
const report = compareStages(actualOutput, golden);

if (!report.pass) {
  const stage = report.firstDivergedStage!;
  console.error(`parity broke at: ${stage}`);
  console.error(report.stages[stage].detail);
}
```

### `STAGE_ORDER`

The canonical, readonly stage order used to pick `firstDivergedStage`.

```ts
const STAGE_ORDER: readonly StageName[];
// ['query-embedding', 'retrieved-ids', 'reranked-ids', 'final-answer']
```

### Types

```ts
type StageName = 'query-embedding' | 'retrieved-ids' | 'reranked-ids' | 'final-answer';
type StageStatus = 'match' | 'diverged';

interface PipelineOutput {
  queryEmbedding: number[]; // flattened — no { dim, vector } wrapper
  retrievedIds: string[];
  rerankedIds: string[];
  finalAnswer: FinalAnswer;
}

interface FinalAnswer {
  citations: string[]; // compared as an unordered set
  topK: string[]; // compared as an ordered list
  seed: number; // compared for exact equality
  text: string; // recorded but NOT compared
}

interface StageResult {
  status: StageStatus;
  detail?: string; // populated on divergence and on the embedding stage
}

interface ParityReport {
  pass: boolean; // true iff every stage matched
  firstDivergedStage: StageName | null; // earliest diverged stage, or null
  stages: Record<StageName, StageResult>; // status for EVERY stage (not short-circuited)
}

interface CompareOptions {
  cosineThreshold?: number; // overrides case.config.cosineThreshold
}
```

> **`PipelineOutput` is flattened relative to the fixture.** The fixture nests the
> embedding under `{ dim, vector }`; the actual output passes a bare
> `queryEmbedding: number[]`, so callers can hand the harness raw stage output
> without rewrapping it.

---

## Configuration reference

### Cosine threshold (embedding tolerance)

The embedding stage matches when `cosine ≥ threshold`. The threshold is resolved
with this precedence:

1. `opts.cosineThreshold` passed to `compareStages` (highest);
2. `golden.case.config.cosineThreshold` from the fixture;
3. the built-in default `0.999` (only if the fixture omits it).

```ts
// Loosen for noisy embedders:
compareStages(actual, golden, { cosineThreshold: 0.99 });

// Tighten toward exact equality:
compareStages(actual, golden, { cosineThreshold: 0.999999 });
```

### Prettier / formatting

The README, this document, and **all committed JSON fixtures** are covered by the
repo Prettier gate (`pnpm format:check`): `printWidth 100`, `singleQuote`, `semi`,
`trailingComma: all`, 2-space indent. After regenerating a fixture, run Prettier
on it (see the [regeneration tutorial](#tutorial-3-regenerating-the-golden-fixture)).
The Python files (`*.py`, `requirements.txt`) have no Prettier parser and are not
formatted by that gate.

### TypeScript build

`parity/diff/tsconfig.json` extends the root `../../tsconfig.base.json`, compiles
`src/` → `dist/`, and emits declarations. Package scripts:

| Script      | Command                | Purpose                     |
| ----------- | ---------------------- | --------------------------- |
| `build`     | `tsc -p tsconfig.json` | Compile to `dist/`          |
| `typecheck` | `tsc --noEmit`         | Type-check without emitting |
| `test`      | `vitest run`           | Run the behavioral spec     |

---

## The Python oracle (`parity/oracle`)

`export_fixtures.py` is the oracle side of the harness. It emits a committed JSON
fixture that freezes the expected output of each pipeline stage, stamped with
provenance.

### Two modes

- **STUB mode (the default, what ships).** Runs on the Python **standard library
  alone** — **no `pip install`**. It produces small, deterministic, synthetic
  stage outputs so the fixture _contract_ (schema + provenance) is fully defined
  and regenerable on any machine with **Python 3.9+**. The committed sample
  fixture is exactly what this stub emits (modulo provenance).
- **REAL mode (not wired up here).** The same provenance/serialization scaffold,
  but the synthetic `_stage_*` helpers are replaced with calls into the upstream
  Python `agent-kgpacks` modules (sentence-transformers embedder, retriever,
  cross-encoder reranker, synthesizer). Pin that environment with
  `requirements.txt`.

### CLI

```bash
python3 parity/oracle/export_fixtures.py [options]
```

| Option      | Default                                        | Meaning                                |
| ----------- | ---------------------------------------------- | -------------------------------------- |
| `--out`     | `parity/diff/test/fixtures/sample-golden.json` | Output JSON path (overwrites in place) |
| `--case-id` | `sample-1`                                     | Fixture case id                        |
| `--query`   | `What is a knowledge pack?`                    | Case query text                        |
| `--seed`    | `42`                                           | Decoding seed                          |
| `--top-k`   | `5`                                            | Number of retrieved candidates         |
| `--dim`     | `8`                                            | Query-embedding dimensionality         |

The default `--out` is resolved **relative to the script**, so the command works
from any working directory. The exporter stamps `provenance.gitSha` from
`git rev-parse HEAD` (falling back to 40 zeros if git is unavailable) and
`provenance.generatedAt` with the current UTC time.

### `requirements.txt`

Pins the **REAL-mode** environment only — the stub needs none of it. Documented as
stub-optional:

```text
sentence-transformers==3.3.1
torch==2.5.1
transformers==4.46.3
numpy==2.1.3
```

```bash
# Real mode only:
python3 -m venv .venv && . .venv/bin/activate
pip install -r parity/oracle/requirements.txt
```

---

## Tutorials

### Tutorial 1 — Diff your pipeline against the golden fixture

```ts
import { loadFixture, compareStages } from '@kgpacks/parity';
import type { PipelineOutput } from '@kgpacks/parity';

const golden = loadFixture('parity/diff/test/fixtures/sample-golden.json');

// Produced by the TS pipeline for golden.case.query:
const actual: PipelineOutput = {
  queryEmbedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  retrievedIds: ['n1', 'n2', 'n3', 'n4', 'n5'],
  rerankedIds: ['n3', 'n1', 'n2'],
  finalAnswer: {
    citations: ['n1', 'n3'], // order doesn't matter
    topK: ['n3', 'n1', 'n2'],
    seed: 42,
    text: 'Any wording — text is ignored.',
  },
};

const report = compareStages(actual, golden);
console.log(report.pass); // true
console.log(report.firstDivergedStage); // null
```

### Tutorial 2 — Reading a divergence report

```ts
const actual = {
  queryEmbedding: golden.stages.queryEmbedding.vector,
  retrievedIds: ['n1', 'n2', 'n3', 'n4', 'nX'], // <- changed last id
  rerankedIds: golden.stages.rerankedIds,
  finalAnswer: { ...golden.stages.finalAnswer },
};

const report = compareStages(actual, golden);

report.pass; // false
report.firstDivergedStage; // 'retrieved-ids'
report.stages['query-embedding'].status; // 'match'
report.stages['retrieved-ids'].status; // 'diverged'
report.stages['retrieved-ids'].detail;
// 'ordered ids differ: expected [n1, n2, n3, n4, n5], got [n1, n2, n3, n4, nX]'
report.stages['reranked-ids'].status; // 'match'  (still evaluated — not short-circuited)
```

If **multiple** stages break, every diverged stage is reported, and
`firstDivergedStage` is the earliest in `STAGE_ORDER`:

```ts
actual.retrievedIds = ['x1', 'x2', 'x3', 'x4', 'x5'];
actual.finalAnswer.citations = ['nope'];

const r = compareStages(actual, golden);
r.firstDivergedStage; // 'retrieved-ids' (earlier than 'final-answer')
r.stages['retrieved-ids'].status; // 'diverged'
r.stages['final-answer'].status; // 'diverged'
r.stages['query-embedding'].status; // 'match'
r.stages['reranked-ids'].status; // 'match'
```

### Tutorial 3 — Regenerating the golden fixture

The stub exporter needs no `pip install`. It overwrites the committed sample in
place; pipe the result through Prettier because the JSON is covered by the format
gate:

```bash
python3 parity/oracle/export_fixtures.py \
  && pnpm exec prettier --write parity/diff/test/fixtures/sample-golden.json
```

Generate a different case:

```bash
python3 parity/oracle/export_fixtures.py \
  --out parity/diff/test/fixtures/case-2.json \
  --case-id case-2 --query "How do I query a pack?" --seed 7 --top-k 8 --dim 16 \
  && pnpm exec prettier --write parity/diff/test/fixtures/case-2.json
```

Each regenerated fixture records its own `provenance` (git SHA, model ids,
binding/storage versions), so a fixture that drifts from the current code is
obvious — fixtures are **regenerable, never "committed and forgotten."**

### Tutorial 4 — Adding a new fixture to the vitest suite

1. Generate the fixture (Tutorial 3) into `parity/diff/test/fixtures/`.
2. Load it with `loadFixture(new URL('./fixtures/<name>.json', import.meta.url))`.
3. Build a matching `PipelineOutput`, then assert `compareStages(...).pass`.
4. Add targeted perturbations to assert the right `firstDivergedStage` for each
   stage you want to cover.

```ts
import { loadFixture, compareStages } from '../src/index.js';

const golden = loadFixture(new URL('./fixtures/case-2.json', import.meta.url));

it('passes for an exact reproduction', () => {
  const out = {
    queryEmbedding: [...golden.stages.queryEmbedding.vector],
    retrievedIds: [...golden.stages.retrievedIds],
    rerankedIds: [...golden.stages.rerankedIds],
    finalAnswer: { ...golden.stages.finalAnswer },
  };
  expect(compareStages(out, golden).pass).toBe(true);
});
```

The bundled `parity.test.ts` is the behavioral specification and covers: exact
match; embedding within / below tolerance; embedding dimension mismatch; a
threshold override; ordered retrieval and reranking divergence; citation
set-equality (reorder matches, missing citation diverges); ignored answer text; a
changed seed; and multi-stage divergence with earliest-wins localization.

---

## Gating checks

These must stay green; the harness is wired into all of them:

| Command                                               | What it asserts                                        |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                      | Lockfile-clean install (only the new workspace member) |
| `pnpm -r build`                                       | `@kgpacks/parity` compiles                             |
| `pnpm -r test` / `pnpm --filter @kgpacks/parity test` | The behavioral spec passes                             |
| `pnpm typecheck`                                      | No type errors                                         |
| `pnpm lint`                                           | ESLint clean                                           |
| `pnpm format:check`                                   | README + this doc + JSON fixtures are Prettier-clean   |
| `pnpm check:no-python`                                | **No runtime package (`packages/*`) touches Python**   |

---

## Scope

**In scope (Phase 1):** the stage-localizing diff utility, the committed sample
golden fixture, the vitest behavioral spec, the stdlib-only Python exporter stub,
the fixture/provenance contract, and the dev-only boundary.

**Out of scope:** the real TypeScript pipeline stages, a real on-disk pack,
porting the Python test suite, MCP/CLI/HTTP snapshot parity, the broader eval
harness, and any CI YAML changes. Real-mode oracle wiring is documented but not
implemented (the `_stage_*` helpers are synthetic stubs).

**Constraints:** tiny synthetic JSON only — **no Wikipedia scraping, no binaries,
no LFS**.

---

See also: [`parity/README.md`](../../parity/README.md) (in-tree dev README),
[docs/PLAN.md](../PLAN.md) (_Parity Methodology_), and
[docs/monorepo.md](../monorepo.md) (workspace layout & tooling).
