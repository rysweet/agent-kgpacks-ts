# Parity Harness (`parity/`)

Dev-time, CI-only tooling for the agent-kgpacks TypeScript port. It pins the
TypeScript pipeline to the behavior of the original Python implementation by
diffing **per-stage** outputs against committed **golden fixtures**, so a
regression is localized to a single stage instead of guessed from an end-to-end
score (see [docs/PLAN.md](../docs/PLAN.md) → _Parity Methodology_).

```
query  ->  query-embedding  ->  retrieved-ids  ->  reranked-ids  ->  final-answer
```

## Dev-only / no-Python-in-runtime boundary

**This is not a shipped runtime package.** Python is permitted **only** as a
development-time parity oracle and must never enter a runtime package's
dependency graph.

- The TypeScript diff utility (`parity/diff`, `@kgpacks/parity`) and the Python
  oracle (`parity/oracle`) communicate **only** through committed JSON. The TS
  side never imports or spawns Python; the oracle never imports TS.
- `scripts/check-no-python.mjs` (root `pnpm check:no-python`) scans `packages/*`
  for Python-flavored dependencies or source that invokes Python. Everything
  Python lives here under `parity/`, **outside** that scan and outside every
  package graph.
- **CI must assert runtime packages contain no Python** by running
  `pnpm check:no-python` (it fails closed on any violation under `packages/*`).

## Layout

```
parity/
├── README.md                         # this file
├── diff/                             # @kgpacks/parity — TS workspace package (dev-only, zero deps)
│   ├── src/                          # cosine, fixture load/validate, stage compare
│   └── test/                         # vitest suite + test/fixtures/sample-golden.json
└── oracle/                           # Python exporter (NOT a workspace package)
    ├── export_fixtures.py            # stdlib-only stub that emits golden fixtures
    └── requirements.txt              # pinned REAL-mode deps (stub needs none)
```

## Fixture schema (`schemaVersion: 1`)

Golden fixtures are committed JSON with camelCase keys:

```jsonc
{
  "schemaVersion": 1,
  "provenance": {
    "gitSha": "<git rev-parse HEAD of the oracle checkout>",
    "generatedAt": "<ISO-8601 UTC>",
    "oracle": "agent-kgpacks-python (stub)",
    "models": { "queryEmbedding": "<id>", "reranker": "<id>", "answer": "<id>" },
    "bindingVersion": "<@ladybugdb/core@x.y.z>",
    "storageVersion": "<kgpack-storage@x>",
  },
  "case": {
    "id": "sample-1",
    "query": "<text>",
    "config": { "topK": 5, "cosineThreshold": 0.999, "seed": 42 },
  },
  "stages": {
    "queryEmbedding": {
      "dim": 8,
      "vector": [
        /* dim floats */
      ],
    },
    "retrievedIds": ["n1", "n2", "n3", "n4", "n5"],
    "rerankedIds": ["n3", "n1", "n2"],
    "finalAnswer": {
      "citations": ["n3", "n1"],
      "topK": ["n3", "n1", "n2"],
      "seed": 42,
      "text": "<free-form, ignored by the comparator>",
    },
  },
}
```

The committed `parity/diff/test/fixtures/sample-golden.json` is a tiny synthetic
fixture (8-dim embedding, five nodes) — no scraped corpora, no binaries. Its
`provenance` uses placeholder values; running the exporter stamps real ones.

## Stage comparison contract (`compareStages`)

| Stage             | Semantics                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `query-embedding` | dimensions must match **and** `cosine ≥ cosineThreshold` (default 0.999)  |
| `retrieved-ids`   | exact **ordered** equality                                                |
| `reranked-ids`    | exact **ordered** equality                                                |
| `final-answer`    | `citations` set-equal, `topK` ordered-equal, `seed` equal; `text` ignored |

All four stages are evaluated (no short-circuit), so the report localizes every
divergence. `firstDivergedStage` is the earliest diverged stage in the order
above; `pass` is true only when every stage matches.

```ts
import { loadFixture, compareStages } from '@kgpacks/parity';

const golden = loadFixture('parity/diff/test/fixtures/sample-golden.json');
const report = compareStages(actualPipelineOutput, golden);
if (!report.pass) {
  console.error(`parity broke at: ${report.firstDivergedStage}`);
  console.error(report.stages[report.firstDivergedStage!].detail);
}
```

`text` is excluded because the answer provider differs in the TS port (Copilot
SDK), so exact text parity is impossible; the harness gives **high confidence on
the retrieval stack** and asserts only structural parity on the answer.

## Build & test (TypeScript)

The diff utility is a normal pnpm workspace member with **zero external
dependencies**:

```bash
pnpm install
pnpm --filter @kgpacks/parity build
pnpm --filter @kgpacks/parity test
```

It is also covered by the repo-wide `pnpm -r build`, `pnpm -r test`,
`pnpm typecheck`, `pnpm lint`, and `pnpm format:check`.

## Regenerate fixtures (Python oracle)

The committed exporter is a **standard-library-only stub** — no `pip install`
needed. It writes the sample fixture in place by default. Because the repo's
Prettier gate formats committed JSON, pipe the result through Prettier:

```bash
python3 parity/oracle/export_fixtures.py \
  && pnpm exec prettier --write parity/diff/test/fixtures/sample-golden.json
```

Options: `--out`, `--case-id`, `--query`, `--seed`, `--top-k`, `--dim`.

**Real mode.** To produce fixtures from the upstream Python `agent-kgpacks`
models instead of the stub, install the pinned environment and replace the
`_stage_*` helpers in `export_fixtures.py` with calls into the real embedder /
retriever / reranker / synthesizer:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r parity/oracle/requirements.txt
```

Each regenerated fixture records its `provenance` (git SHA, model ids,
binding/storage versions) so stale fixtures are obvious — fixtures are
regenerable, never "committed and forgotten."
