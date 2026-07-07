# Packaging: the self-contained `wikigr` tarball

This document describes how `agent-kgpacks-ts` is packaged into a **correct,
self-contained, installable npm tarball** — and how to consume, verify, and
(intentionally _not_) publish it.

The **root** package (`agent-kgpacks-ts`) is the installable artifact. It exposes
a single `bin`, `wikigr` → `dist/wikigr.mjs`. Even though the repository is a
**pnpm@9 workspace monorepo**, a consumer never needs pnpm or workspace
resolution: a `prepack`/`prepare` step bundles the CLI together with all of its
internal `@kgpacks/*` workspace source into one file, and only the **real npm
runtime dependencies** are installed from the tarball's `dependencies`.

- **You want to _use_ the CLI:** see [Installing the CLI](#installing-the-cli).
- **You want to _build a tarball_:** see [Building a tarball](#building-a-tarball).
- **You are wondering why `npm publish` fails:** that is on purpose — see
  [Publishing is blocked by design](#publishing-is-blocked-by-design).

## TL;DR

```bash
corepack enable
pnpm install
pnpm -r build
npm pack                      # -> agent-kgpacks-ts-<version>.tgz (ships only dist/)

# In any clean directory, with plain npm (no pnpm, no workspace):
npm install ./agent-kgpacks-ts-<version>.tgz
npx wikigr --help             # zero missing-module errors
npx wikigr query --help
```

## How the packaging works

### The bundle (`scripts/bundle-cli.mjs`)

`scripts/bundle-cli.mjs` runs **esbuild** to produce `dist/wikigr.mjs`:

- **Inlines** all first-party `@kgpacks/*` workspace source into the single output
  file, so the consumer needs no workspace linking and no `@kgpacks/*` packages on
  npm.
- **Marks every real npm import `external`**, so those packages are _not_ inlined
  and are instead resolved at install time from the tarball's `dependencies`.

Because the externalized packages are resolved by the consumer, the **union of all
externalized bare imports in `dist/wikigr.mjs` must be fully declared in the root
`package.json` `dependencies`**. Today that set is:

| Externalized import         | Declared in root `dependencies` |
| --------------------------- | ------------------------------- |
| `@github/copilot-sdk`       | ✅                              |
| `@ladybugdb/core`           | ✅                              |
| `@huggingface/transformers` | ✅                              |
| `commander`                 | ✅                              |

Node builtins (`node:*`, `fs`, `path`, …) are never externalized as dependencies.
The [CI packaging smoke test](#ci-the-package-smoke-job) exists precisely so this
table can never silently drift.

### Lifecycle scripts (root `package.json`)

| Script           | Runs when                                                               | Behavior                                                                                                        |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `prepare`        | after `npm install` / `pnpm install` in a checkout, and on git installs | Builds the bundle, **then** runs the husky guard: `node scripts/bundle-cli.mjs && node scripts/setup-husky.mjs` |
| `prepack`        | before `npm pack` / `npm publish`                                       | Builds the bundle so `dist/` is present in the tarball: `node scripts/bundle-cli.mjs`                           |
| `prepublishOnly` | before `npm publish` only                                               | Publish gate: `node scripts/guard-publish.mjs` (see [below](#publishing-is-blocked-by-design))                  |

The bundle build **always runs first and unguarded** in `prepare`/`prepack`, so a
real build failure is never hidden by the husky guard.

`dist/` is **not committed** (it is git-ignored) but is shipped via
`files: ["dist"]`; `npm pack`/`npm publish` rebuild it through `prepack`.

### The husky guard (`scripts/setup-husky.mjs`)

Git hooks are a **developer convenience**, not a packaging requirement, so their
setup must never break an install. `scripts/setup-husky.mjs` **fails open** — it
installs husky hooks in a dev checkout but **no-ops with exit code 0** when hooks
are neither wanted nor possible:

| Condition                        | Result        |
| -------------------------------- | ------------- |
| `CI` environment variable is set | no-op (0)     |
| `HUSKY=0` (husky disabled)       | no-op (0)     |
| Not inside a git work tree       | no-op (0)     |
| `husky` package not installed    | no-op (0)     |
| Dev checkout in a git work tree  | install hooks |

This is why `npm install github:rysweet/agent-kgpacks-ts` succeeds on a consumer
machine: the git-install runs `prepare`, the bundle builds, and the husky guard
quietly no-ops because the consumer is not in this repo's git work tree.

> **Guard direction matters.** The husky guard **fails open** (missing hooks are
> harmless). The publish guard **fails closed** (an accidental publish is not).
> Do not invert either one.

## Installing the CLI

The package is **not published to any npm registry**, but the `wikigr` CLI can be
installed straight from git or from a locally built tarball. Both paths yield the
same executable.

### From git

```bash
# Global install straight from the repo
npm install -g github:rysweet/agent-kgpacks-ts
wikigr --help

# …or as a project dependency
npm install github:rysweet/agent-kgpacks-ts
#   package.json -> "dependencies": { "agent-kgpacks-ts": "github:rysweet/agent-kgpacks-ts" }

# …or pin a branch / tag / commit
npm install "github:rysweet/agent-kgpacks-ts#main"
```

### From a tarball (air-gapped / offline)

```bash
pnpm install && pnpm -r build && npm pack   # -> agent-kgpacks-ts-<version>.tgz
npm install -g ./agent-kgpacks-ts-<version>.tgz
wikigr --help
```

Requires **Node 22 LTS or newer**. On the supported platforms — Linux
(`x64`/`arm64`), macOS (`x64`/`arm64`), and Windows (`x64`) — **no C/C++ toolchain
is needed**: `@ladybugdb/core` ships a prebuilt native binary for each as a
platform-specific `optionalDependency`. Any other platform falls back to compiling
`@ladybugdb/core` from source at install time, which does require CMake and a
C/C++ toolchain.

## Building a tarball

```bash
corepack enable            # activate the pinned pnpm@9
pnpm install               # frozen in CI (--frozen-lockfile)
pnpm -r build              # compile all workspace packages
npm pack                   # runs prepack -> bundles dist/, emits the .tgz
```

Inspect exactly what ships (should contain only `dist/`, `package.json`, and the
usual npm metadata — **never** `scripts/`, `.env`, or source):

```bash
npm pack --dry-run
tar tzf agent-kgpacks-ts-<version>.tgz
```

### Verify a clean install (the same check CI runs)

Always verify with **plain `npm`** in a directory **outside** the workspace, so no
pnpm workspace state can leak in:

```bash
TARBALL="$PWD/agent-kgpacks-ts-<version>.tgz"
TMP="$(mktemp -d)" && cd "$TMP"
npm init -y >/dev/null
npm install "$TARBALL"

./node_modules/.bin/wikigr --help          # zero missing-module errors
./node_modules/.bin/wikigr query --help
```

If any externalized dependency were missing from the root `dependencies`, these
commands would fail with `Cannot find module …`. A green run proves the
externals/dependencies union is complete.

## Publishing is blocked by design

`npm publish` from this repository is **intentionally blocked**. Publishing to the
downstream private feed is the job of a **separate, downstream private-feed
pipeline** — never this repo, and **no private-feed URL is stored anywhere in this
repository**.

The gate is the `prepublishOnly` script (`scripts/guard-publish.mjs`), which
**fails closed**: it exits non-zero and prints an explanatory error **unless** the
environment variable `KGPACKS_ALLOW_PUBLISH` is set exactly to `1`.

```bash
# Blocked (the normal case):
npm publish
#   Refusing to publish agent-kgpacks-ts from this repository.
#
#   Publishing is performed by the downstream private-feed pipeline, not from
#   this repo. This repo only produces the installable tarball via `npm pack`.
#
#   If you are that pipeline and really intend to publish, re-run with
#   KGPACKS_ALLOW_PUBLISH=1 set in the environment.

# Only the downstream pipeline opts in explicitly:
KGPACKS_ALLOW_PUBLISH=1 npm publish
```

> Removing `"private": true` (which previously blocked `npm pack` of the tarball)
> is what makes the packed artifact installable. The `prepublishOnly` guard
> replaces that blanket block with a **targeted** publish gate, so packing works
> while accidental publishing does not.

### Configuration reference

| Variable                | Consumed by                 | Values                 | Effect                                                                   |
| ----------------------- | --------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `KGPACKS_ALLOW_PUBLISH` | `scripts/guard-publish.mjs` | `1` to allow           | Any value other than exactly `1` (including unset) blocks `npm publish`. |
| `CI`                    | `scripts/setup-husky.mjs`   | any truthy set         | Skips husky hook installation (no-op, exit 0).                           |
| `HUSKY`                 | `scripts/setup-husky.mjs`   | `0`/`false` to disable | Skips husky hook installation (no-op, exit 0).                           |

## CI: the `package-smoke` job

`.github/workflows/ci.yml` includes a deterministic **`package-smoke`** job so
packaging regressions are caught automatically. It:

1. Checks out the repo and enables Corepack (pinned pnpm@9, Node ≥ 22).
2. `pnpm install --frozen-lockfile` and builds the bundle.
3. Runs `npm pack` to produce the tarball.
4. Installs the tarball into a **clean directory** with **plain `npm install`**
   (not pnpm), mirroring a real consumer.
5. Smoke-tests the `wikigr` bin (`wikigr --help`, `wikigr query --help`) and
   fails the job on any missing-module error.

The job runs with least privilege (`permissions: contents: read`) and uses
SHA-pinned actions. If a future change externalizes a new npm import without
declaring it in the root `dependencies`, this job goes red.

## Troubleshooting

| Symptom                                                    | Cause / Fix                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module '<pkg>'` after `npm install <tarball>` | A newly externalized import is missing from root `dependencies`. Add it, rebuild, re-run the smoke test.                     |
| `npm publish` fails with the guard message                 | Working as intended. Publishing is done by the downstream pipeline. Set `KGPACKS_ALLOW_PUBLISH=1` only if you truly mean to. |
| Git install fails during `prepare`                         | Inspect the **bundle** step — the husky guard no-ops and never fails, so a `prepare` failure is a real esbuild/build error.  |
| Hooks not installed in your local checkout                 | Ensure you are in a git work tree and `CI`/`HUSKY=0` are not set; the guard skips hook setup in those cases.                 |

## See also

- [docs/monorepo.md](monorepo.md) — workspace layout and everyday build/test/lint commands.
- [docs/ci-perf-guards.md](ci-perf-guards.md) — other deterministic CI guards.
- [docs/deployment.md](deployment.md) — production Docker deployment.
