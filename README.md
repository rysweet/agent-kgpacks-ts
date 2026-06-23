# agent-kgpacks (TypeScript)

TypeScript port of [agent-kgpacks](https://github.com/rysweet/agent-kgpacks) — a
knowledge-pack platform that builds domain knowledge graphs from documentation,
stores them in **LadybugDB** (graph + vector + FTS), and answers questions with a
graph-RAG agent powered by the **GitHub Copilot SDK**.

> Status: **Phase 0 foundations in place** — a pnpm/Node 22 strict-ESM monorepo
> with eight buildable `@kgpacks/*` skeletons plus `@kgpacks/db` (a minimal
> LadybugDB wrapper carrying the first slice of Spike A, a vector smoke test),
> shared tooling, CI, and a python-free guard. No business logic yet beyond that
> slice; the full Spike A (real-pack read, FTS + graph queries, and the
> concurrency-model decision) is still outstanding. See
> [docs/PLAN.md](docs/PLAN.md) for the full end-to-end port plan (phases, parity
> methodology, acceptance criteria).

## Why a TypeScript port?

- Single-language stack (the existing frontend is already TypeScript/React).
- Agent interactions via the GitHub Copilot SDK.
- No Python dependency in the shipped artifact (Python is used only as a
  development-time parity oracle).

## Getting started

```bash
corepack enable          # activate the pinned pnpm@9
pnpm install             # install workspace dependencies
pnpm -r build            # compile all packages
pnpm -r test             # run all tests (includes Spike A)
```

Requires **Node 22 LTS or newer**. No C/C++ toolchain needed —
`@ladybugdb/core` ships prebuilt native binaries.

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
- [docs/packages/frontend.md](docs/packages/frontend.md) — the `@kgpacks/frontend`
  web app (`apps/frontend/`): the Vite + React 18 SPA, the typed `/api/v1` client,
  the chat SSE streaming contract, the UI components, and the build/test strategy.
- [docs/PLAN.md](docs/PLAN.md) — the end-to-end TypeScript port plan.

## License

MIT
