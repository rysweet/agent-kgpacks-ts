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

## Build and query a pack

```bash
# Build a knowledge pack from seed URLs (fetch → extract → embed → index)
wikigr create --pack quantum --seeds https://en.wikipedia.org/wiki/Quantum_entanglement

# Query it (vector / hybrid retrieval)
wikigr query quantum "What is quantum entanglement?"

# Serve the HTTP API (chat + SSE, search, graph) and the web UI
pnpm --filter @kgpacks/backend start
pnpm --filter @kgpacks/frontend dev
```

## Documentation

- [docs/monorepo.md](docs/monorepo.md) — workspace layout, build/test/lint
  commands, configuration reference, CI, and how to add a package.
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
- [docs/PLAN.md](docs/PLAN.md) — the architecture, parity methodology, external
  contracts, and acceptance criteria for the port.

## License

MIT
