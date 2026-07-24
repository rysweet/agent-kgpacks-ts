# agent-kgpacks (TypeScript)

TypeScript port of [agent-kgpacks](https://github.com/rysweet/agent-kgpacks) — a
knowledge-pack platform that builds domain knowledge graphs from documentation,
stores them in **LadybugDB** (graph + vector + FTS), and answers questions with a
graph-RAG agent powered by the **GitHub Copilot SDK**.

## Why a TypeScript port?

- Single-language stack (the existing frontend is already TypeScript/React).
- Agent interactions via the GitHub Copilot SDK.
- No Python dependency in the shipped artifact.

## Getting started

```bash
corepack enable          # activate the pinned pnpm@9
pnpm install             # install workspace dependencies
pnpm -r build            # compile all packages
pnpm -r test             # run all tests
```

Requires **Node 22 LTS or newer**. No C/C++ toolchain needed —
`@ladybugdb/core` ships prebuilt native binaries. Building or querying a pack
uses the GitHub Copilot CLI (install and sign in with `copilot`).

## Install from git (without publishing to npm)

This package is **not published to any npm registry** — publishing is the job of a
downstream private-feed pipeline, and `npm publish` from this repo is blocked unless
`KGPACKS_ALLOW_PUBLISH=1` is set. The `wikigr` CLI can, however, be installed
straight from this repository or from a locally built tarball. On install, a
`prepare` step bundles the CLI and its internal `@kgpacks/*` workspace packages into
a single self-contained file (`dist/wikigr.mjs`); only the real runtime dependencies
(`@ladybugdb/core`, `@huggingface/transformers`, `@github/copilot-sdk`, `commander`)
are installed from npm — no pnpm and no workspace resolution is required on the
consumer side. See **[docs/packaging.md](docs/packaging.md)** for the full details.

```bash
# Install the CLI globally from the git repo
npm install -g github:rysweet/agent-kgpacks-ts
wikigr --help

# …or add it to a project as a git dependency
npm install github:rysweet/agent-kgpacks-ts
#   package.json -> "dependencies": { "agent-kgpacks-ts": "github:rysweet/agent-kgpacks-ts" }

# …or pin a branch / tag / commit
npm install "github:rysweet/agent-kgpacks-ts#main"
```

Prefer a tarball (e.g. for air-gapped installs)? Build one from a checkout and
install it anywhere:

```bash
pnpm install && npm pack          # -> agent-kgpacks-ts-<version>.tgz (contains dist/)
npm install -g ./agent-kgpacks-ts-<version>.tgz
```

Both paths yield the same `wikigr` executable as the workspace build below.

## Download a prebuilt pack

> 📘 **New here? See the step-by-step [Install & use the CVE knowledge pack](docs/using-the-cve-pack.md) guide.**

Knowledge packs (e.g. the full CVE pack) are large binary databases, so they are
**not committed to git**. They are published as **GitHub Release** assets and
installed with `wikigr pack pull`. Because packs can exceed GitHub's 2 GiB
per-asset limit, each pack is split into multiple parts plus a
`<name>.pack-release.json` index carrying per-part and overall SHA-256 sums; the
pull command downloads the parts, verifies every checksum, and streams the
reassembled archive straight into the pack registry (nothing is buffered whole,
so multi-GB packs install with bounded memory).

```bash
# Download + install the CVE pack from the repo's release assets
wikigr pack pull cve

# Then query it like any local pack
wikigr query cve "remote code execution in a Joomla extension" -k 5

# Override the source (e.g. a fork, a specific tag, or a local mirror)
wikigr pack pull cve --repo rysweet/agent-kgpacks-ts --tag packs
wikigr pack pull cve --base-url http://127.0.0.1:8799
```

Already have a `<name>.tar.gz` archive locally? `wikigr pack install <archive>`
installs it directly. To **publish** a pack you built, see
[docs/cve.md](docs/cve.md#publish-a-pack-as-a-release-artifact).

## Build and query a pack

```bash
# Build a knowledge pack from seed URLs (fetch → extract → embed → index)
wikigr create --pack quantum --seeds https://en.wikipedia.org/wiki/Quantum_entanglement

# Query it (vector / hybrid retrieval)
wikigr query quantum "What is quantum entanglement?"

# Serve the HTTP API (chat + SSE, search, graph) and the web UI
pnpm --filter @kgpacks/backend build
WIKIGR_DATABASE_PATH=data/packs/quantum/pack.db node packages/backend/dist/index.js
pnpm --filter @kgpacks/frontend dev
```

## Documentation

- **[docs/using-the-cve-pack.md](docs/using-the-cve-pack.md) — install & use the
  prebuilt CVE knowledge pack (start here to use the database).**
- [docs/cve.md](docs/cve.md) — how the CVE pack is built and published.
- [docs/howto/incremental-cve-update.md](docs/howto/incremental-cve-update.md) —
  workflow for building and resuming an immutable CVE pack update.
- [docs/reference/incremental-update.md](docs/reference/incremental-update.md) —
  schema-v2 update API, delta grammar, durable metadata, validation, and
  atomic publication contract.
- [docs/reference/cve-adapter.md](docs/reference/cve-adapter.md) — exact CVE
  record mapping, affected-product fallback, and Unicode truncation behavior.
- [docs/reference/pack-management.md](docs/reference/pack-management.md) —
  pack pull source resolution, stable release eligibility, integrity
  checks, manifest schema dispatch, and programmatic API behavior.
- [docs/cve-corpus.md](docs/cve-corpus.md) — fetching the source CVE corpus from
  the CVEProject/cvelistV5 release service (`pnpm cve:fetch`).
- [docs/resumable-build.md](docs/resumable-build.md) — resumable + pipelined CVE
  pack builds (checkpoint/resume, overlapped embed + load).
- [docs/pack-quantization.md](docs/pack-quantization.md) — the int8 embedding
  quantization spike (~4× smaller vectors) and its recall-parity adoption gate.
- [docs/cve-eval.md](docs/cve-eval.md) — evaluating the CVE pack (both arms + pinned
  judge) and the committed eval-results artifact.
- [docs/pack-versioning.md](docs/pack-versioning.md) — versioned release tags
  (`cve-YYYY.MM`) and the pack provenance fields.
- [docs/pack-signing.md](docs/pack-signing.md) — signing & verifying the release
  index (Ed25519 authenticity on top of SHA-256 integrity).
- [docs/entity-graph.md](docs/entity-graph.md) — entity-graph traversal:
  `entityGraph()` + `GET /api/v1/graph/entities` (co-occurrence / relation modes).
- [docs/packs-directory.md](docs/packs-directory.md) — where the CLI/MCP server
  read & write packs (the XDG default and how to override it).
- [docs/monorepo.md](docs/monorepo.md) — workspace layout, build/test/lint
  commands, configuration reference, CI, and how to add a package.
- [docs/ci-perf-guards.md](docs/ci-perf-guards.md) — the CI performance/scaling
  guards (multi-part release accounting + streaming-loader ~linear edge creation).
- [docs/packaging.md](docs/packaging.md) — how the self-contained `wikigr` tarball
  is built, installed, verified, and why publishing is blocked from this repo.
- [docs/packages/db.md](docs/packages/db.md) — the `@kgpacks/db` LadybugDB
  wrapper API and the Spike A vector smoke-test tutorial.
- [docs/packages/agent.md](docs/packages/agent.md) — the `@kgpacks/agent` GitHub
  Copilot SDK LLM-layer API contract (answer synthesis, query expansion,
  multi-query, seed-article identification, and token/usage accounting).
- [docs/packages/parity.md](docs/packages/parity.md) — the dev-time
  `@kgpacks/parity` harness: golden-fixture schema, stage comparison contract,
  TypeScript API, the Python oracle, and regeneration tutorials.
- [docs/packages/eval.md](docs/packages/eval.md) — the `@kgpacks/eval` evaluation
  layer: the `runEval` runner, with-pack/training-only baselines, the pinned LLM
  judge, skill evaluators, deterministic stratified sampling, and metric
  definitions.
- [docs/packages/frontend.md](docs/packages/frontend.md) — the `@kgpacks/frontend`
  web app (`apps/frontend/`): the Vite + React 18 SPA, the typed `/api/v1` client,
  the chat SSE streaming contract, the UI components, and the build/test strategy.
- [docs/deployment.md](docs/deployment.md) — production Docker deployment: the
  multi-stage build, `docker compose` run, the GLIBC (no-Alpine) requirement, env
  vars, persistence, the VECTOR/FTS first-load network prerequisite, and version
  pinning.
- [docs/catalog.md](docs/catalog.md) — the knowledge-pack catalog: the `catalog/`
  layout, the data-driven `catalog:build` / `catalog:eval` workflow, the pinned
  synthesis and judge models, and what is (and isn't) committed.
- [docs/cve.md](docs/cve.md) — building a knowledge pack from the MITRE / CVE
  Program vulnerability corpus: the structured (LLM-free) ingestion path, the
  CVE→graph mapping, and the `cve:build` workflow.
- [docs/PLAN.md](docs/PLAN.md) — the architecture, parity methodology, external
  contracts, and acceptance criteria for the port.

## License

MIT
