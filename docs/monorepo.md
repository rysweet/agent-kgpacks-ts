# Monorepo Foundation (Phase 0)

This document describes the TypeScript monorepo that hosts the `agent-kgpacks`
TypeScript port. It covers the workspace layout, prerequisites, the everyday
build/test/lint commands, the shared configuration, continuous integration, and
how to add a new package.

The scaffold implements **Phase 0 — Foundations** from
[docs/PLAN.md](./PLAN.md): a pnpm workspace targeting **Node 22 LTS** with
**strict TypeScript ESM**, a shared base `tsconfig`, ESLint + Prettier, Vitest,
a CI pipeline, and a hard guarantee that **no runtime package depends on or
invokes Python**. The only package containing logic at this stage is
[`@kgpacks/db`](./packages/db.md), which carries a minimal LadybugDB wrapper and
the first slice of **Spike A** — a synthetic vector smoke test. The remainder of
Spike A (real-pack read, FTS + graph queries, and the concurrency-model decision)
is still outstanding; see
[`docs/packages/db.md`](./packages/db.md#spike-a-vector-smoke-test).

> Status: the foundation is in place. No business logic exists yet beyond the
> Spike A vector smoke-test slice in `@kgpacks/db` — every other package is a
> buildable skeleton.

## Prerequisites

| Tool     | Version                      | Notes                                                                                                |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Node.js  | **22 LTS or newer** (`>=22`) | Enforced via the root `engines.node` field. CI runs on Node 22.                                      |
| pnpm     | **9 (exact pin)**            | Pinned to an exact version via `packageManager` (e.g. `pnpm@9.15.0`) and activated through Corepack. |
| Corepack | bundled with Node            | Run `corepack enable` once to get the exact pinned pnpm.                                             |

You do **not** need a C/C++ build toolchain. `@ladybugdb/core` ships prebuilt
native binaries (including `linux-x64`) as platform-specific
`optionalDependencies`; its install step only _selects and links_ the prebuilt
binary for the current platform (nothing is compiled), so installs work out of
the box on supported platforms.

### One-time setup

```bash
corepack enable          # makes the pinned pnpm@9 available
pnpm install             # installs all workspace dependencies (frozen in CI)
```

## Workspace layout

```text
.
├── package.json              # private root; workspace scripts + tool pins
├── pnpm-workspace.yaml        # workspace globs (packages/*, parity/*, apps/*)
├── pnpm-lock.yaml             # committed lockfile (reproducible installs)
├── tsconfig.base.json         # shared strict-ESM TypeScript settings
├── eslint.config.js           # ESLint 9 flat config (+ typescript-eslint, prettier)
├── .prettierrc                # Prettier formatting rules
├── vitest.config.ts           # root Vitest configuration
├── .npmrc                     # pnpm settings (Corepack, build allow-list)
├── scripts/
│   └── check-no-python.mjs     # python-free guard (CI security gate)
├── .github/workflows/
│   └── ci.yml                  # install → typecheck → lint → build → test (+ guard)
├── docs/
│   ├── PLAN.md                 # end-to-end port plan
│   ├── monorepo.md             # this document
│   └── packages/
│       ├── db.md               # @kgpacks/db API + Spike A tutorial
│       ├── agent.md            # @kgpacks/agent Copilot SDK API contract
│       ├── packs.md            # @kgpacks/packs API + installer/security model
│       ├── backend.md          # @kgpacks/backend HTTP API + SSE contract
│       ├── frontend.md         # @kgpacks/frontend SPA + /api/v1 client contract
│       └── mcp.md              # @kgpacks/mcp stdio server + external contract
├── apps/
│   └── frontend/               # @kgpacks/frontend — Vite + React 18 SPA
└── packages/
    ├── db/                     # @kgpacks/db   — LadybugDB wrapper (+ Spike A)
    ├── embeddings/             # @kgpacks/embeddings
    ├── agent/                  # @kgpacks/agent
    ├── query/                  # @kgpacks/query
    ├── packs/                  # @kgpacks/packs
    ├── backend/                # @kgpacks/backend
    ├── cli/                    # @kgpacks/cli
    ├── mcp/                    # @kgpacks/mcp
    └── eval/                   # @kgpacks/eval
```

Each package under `packages/` follows the same shape:

```text
packages/<name>/
├── package.json     # name "@kgpacks/<name>", "type": "module", scripts
├── tsconfig.json    # extends ../../tsconfig.base.json (outDir dist, rootDir src)
├── README.md        # one-paragraph responsibility stub (from docs/PLAN.md)
└── src/
    └── index.ts     # placeholder entry point
```

### Packages and their responsibilities

These mirror the Default Stack in [docs/PLAN.md](./PLAN.md). In Phase 0 they are
buildable skeletons; logic is added later, gated by parity tests (see the plan's
phase ordering).

| Package               | Responsibility                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kgpacks/db`         | LadybugDB wrapper over `@ladybugdb/core` (connection management, parameters, Cypher helpers, extension loading). **Contains the Spike A vector smoke-test slice.** |
| `@kgpacks/embeddings` | Transformers.js BGE query embeddings (with the BGE query prefix) + cross-encoder reranker.                                                                         |
| `@kgpacks/agent`      | Copilot SDK client/session management; synthesis, query expansion, multi-query, seed-article identification.                                                       |
| `@kgpacks/query`      | Retrieval pipeline: vector search, graph reranker, multi-doc synthesis, few-shot, cross-encoder, Cypher-RAG, Cypher safety validation.                             |
| `@kgpacks/packs`      | Manifest model, installer, validator, registry, distribution (`tar.gz`), versioning.                                                                               |
| `@kgpacks/backend`    | Fastify + SSE service (replaces FastAPI): chat (POST + GET stream), search, graph, hybrid, articles; rate limiting.                                                |
| `@kgpacks/cli`        | `commander`/`yargs` CLI: query + pack subcommands (ingestion subcommands arrive in Phase 2).                                                                       |
| `@kgpacks/mcp`        | TypeScript MCP server exposing `list_packs`, `pack_info`, `query_knowledge_pack`.                                                                                  |
| `@kgpacks/eval`       | Eval runner + judge (Copilot SDK), baselines, skill evaluators.                                                                                                    |

> `@kgpacks/ingestion` is intentionally **not** scaffolded in Phase 0 — it lands
> in Phase 2. The **frontend** has since shipped as the workspace's first
> _application_: it lives under [`apps/frontend/`](../apps/frontend/README.md)
> (not `packages/`) because it is a deployable SPA rather than a library, and its
> `apps/` placement keeps it out of the `packages/*`-only structural suites. See
> [docs/packages/frontend.md](./packages/frontend.md).

## Everyday commands

All commands run from the repository root. The root `package.json` fans them out
across every workspace package with `pnpm -r` (recursive).

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm install`      | Install all workspace dependencies.                                  |
| `pnpm build`        | `pnpm -r build` — compile every package with `tsc` into its `dist/`. |
| `pnpm test`         | `pnpm -r test` — run each package's Vitest suite.                    |
| `pnpm typecheck`    | Type-check every package with `tsc --noEmit`.                        |
| `pnpm lint`         | Run ESLint across the workspace.                                     |
| `pnpm format`       | Rewrite files in place with Prettier.                                |
| `pnpm format:check` | Verify formatting without writing (used by CI).                      |

### The canonical acceptance check

The Phase 0 definition of done is that the following passes from a clean clone:

```bash
pnpm install && pnpm -r build && pnpm -r test
```

`pnpm -r build` compiles all nine packages; `pnpm -r test` runs every Vitest
suite, including [Spike A](./packages/db.md#spike-a-vector-smoke-test).
Packages without tests pass cleanly because Vitest is invoked with
`--passWithNoTests`.

### Targeting a single package

Use pnpm's `--filter` to scope a command to one package:

```bash
pnpm --filter @kgpacks/db build      # build only @kgpacks/db
pnpm --filter @kgpacks/db test       # run only Spike A
pnpm --filter @kgpacks/db typecheck  # type-check only @kgpacks/db
```

## Configuration reference

### `tsconfig.base.json`

The shared base every package extends. It enforces strict, modern, ESM-first
TypeScript:

| Option             | Value      | Why                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------- |
| `strict`           | `true`     | Full strictness, no implicit `any`.                                       |
| `target`           | `ES2022`   | Matches Node 22 capabilities.                                             |
| `module`           | `NodeNext` | Native ESM module emit.                                                   |
| `moduleResolution` | `NodeNext` | Node ESM resolution — relative imports require explicit `.js` extensions. |
| `declaration`      | `true`     | Emit `.d.ts` files for downstream packages.                               |
| `esModuleInterop`  | `true`     | Clean interop with CommonJS dependencies.                                 |
| `skipLibCheck`     | `true`     | Skip type-checking of `.d.ts` from dependencies.                          |

> **ESM gotcha:** because resolution is `NodeNext`, intra-package relative
> imports must include the compiled extension, e.g.
> `import { Database } from './database.js'` (not `'./database'`), even though
> the source file is `database.ts`.

Each package's `tsconfig.json` extends this base and sets only what is local:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
  },
  "include": ["src"],
}
```

### Root `package.json`

```jsonc
{
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
  },
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - packages/* # libraries (@kgpacks/db … @kgpacks/backend)
  - parity/* # dev-only parity harness (parity/diff)
  - apps/* # applications (apps/frontend — the React SPA)
```

> The frontend lives under `apps/`, not `packages/`, because it is a deployable
> application rather than a library — and because the structural governance suites
> (`test/scaffold.test.ts`) and the python-free guard only scan `packages/*`.

### `.npmrc`

Configures pnpm for reproducible, secure installs:

- An explicit **build allow-list** (`onlyBuiltDependencies`) permits
  `@ladybugdb/core` to run its install/postinstall step while blocking arbitrary
  dependency build scripts. That postinstall **selects and links the prebuilt
  native binary** for the current platform — it does not compile anything from
  source.

> Note: the pnpm version itself is pinned by the `packageManager` field in the
> **root `package.json`** (consumed by Corepack), not in `.npmrc`.

### ESLint & Prettier

- **`eslint.config.js`** — ESLint 9 **flat config** composing `typescript-eslint`
  with `eslint-config-prettier` (so ESLint never fights Prettier on formatting).
- **`.prettierrc`** — the single source of truth for formatting. CI runs
  `prettier --check`; contributors run `pnpm format` to fix.

### Vitest

`vitest.config.ts` lives at the root and is shared by all packages. Each
package's `test` script is `vitest run`, and the runner is configured with
`--passWithNoTests` so skeleton packages with no specs still report success.

## Continuous integration

CI is defined in `.github/workflows/ci.yml` and runs on pushes and pull
requests. Actions are pinned by commit SHA, and the workflow uses least-
privilege `permissions: contents: read`.

### Job: `build` (Node 22)

1. **Checkout**
2. **Enable Corepack** and activate the pinned pnpm.
3. **Install** with `pnpm install --frozen-lockfile` (fails if `pnpm-lock.yaml`
   is out of date).
4. **Typecheck** — `pnpm typecheck`
5. **Lint** — `pnpm lint`
6. **Format check** — `pnpm format:check`
7. **Build** — `pnpm -r build`
8. **Test** — `pnpm -r test` (includes Spike A)

pnpm's store is cached between runs to speed installs.

### Job: `python-free-guard`

A separate, independent job runs the security gate:

```bash
node scripts/check-no-python.mjs
```

The guard enforces the hard constraint from [docs/PLAN.md](./PLAN.md): **no
runtime package may declare or invoke a Python dependency.** It fails the build
if it finds, anywhere under `packages/`:

- a Python-flavored dependency in any `packages/*/package.json`, or
- source under `packages/*/src/**` that spawns/invokes `python`, `pip`, or a
  `.py` script.

Python is permitted only as a **development-time parity oracle**, kept outside
the runtime packages' dependency graph — never in the shipped artifact. See the
guard's own documentation: [`scripts/check-no-python.mjs`](#the-python-free-guard).

### The python-free guard

`scripts/check-no-python.mjs` is a dependency-free Node script. You can run it
locally exactly as CI does:

```bash
node scripts/check-no-python.mjs
```

- **Exit code `0`** — no Python references found; prints a short summary.
- **Exit code `1`** — at least one violation; prints the offending file and the
  matched pattern, then exits non-zero so CI fails closed.

## Adding a new package

Phase 0 packages are deliberately uniform, so adding one is mechanical:

1. Create `packages/<name>/` with this structure:

   ```text
   packages/<name>/
   ├── package.json
   ├── tsconfig.json
   ├── README.md
   └── src/index.ts
   ```

2. **`package.json`** — name it `@kgpacks/<name>` and copy the standard scripts:

   ```jsonc
   {
     "name": "@kgpacks/<name>",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc -p tsconfig.json",
       "typecheck": "tsc --noEmit",
       "test": "vitest run",
     },
   }
   ```

3. **`tsconfig.json`** — extend the base (see [`tsconfig.base.json`](#tsconfigbasejson)).

4. **`README.md`** — one paragraph describing the package's responsibility (use
   the matching row from the [responsibilities table](#packages-and-their-responsibilities)).

5. **`src/index.ts`** — start with a placeholder export.

6. Run `pnpm install` so pnpm links the new workspace, then
   `pnpm --filter @kgpacks/<name> build` to confirm it compiles.

> Keep new runtime packages Python-free — the guard will reject any Python
> dependency or invocation.

## See also

- [docs/PLAN.md](./PLAN.md) — the end-to-end port plan (phases, parity
  methodology, acceptance criteria).
- [docs/packages/db.md](./packages/db.md) — `@kgpacks/db` API reference and the
  Spike A vector smoke-test tutorial.
- [docs/packages/agent.md](./packages/agent.md) — `@kgpacks/agent` Copilot SDK
  LLM-layer API contract (synthesis, query expansion, multi-query, seed-article
  identification, usage accounting).
- [docs/packages/packs.md](./packages/packs.md) — `@kgpacks/packs` API reference
  (manifest, versioning, installer, registry) and the archive-extraction security
  model.
- [docs/packages/mcp.md](./packages/mcp.md) — `@kgpacks/mcp` stdio MCP server: the
  three knowledge-pack tools, the snapshot-locked external contract, the query
  seam, and parity notes.
- [docs/packages/backend.md](./packages/backend.md) — `@kgpacks/backend` HTTP API
  reference: the `/api/v1` route contract, the chat SSE protocol, configuration,
  rate limiting, and the per-request connection lifecycle.
- [docs/packages/frontend.md](./packages/frontend.md) — `@kgpacks/frontend` web app
  (`apps/frontend/`): the Vite + React 18 SPA, the typed `/api/v1` client, the chat
  SSE streaming contract, the UI components, the `apps/` placement and `apps/**`
  ESLint override, and the build/test strategy.
