# @kgpacks/cli

The `wikigr` command-line interface — a Commander port of the upstream CLI's
**RUNTIME** commands. Phase 1 covers querying and pack management; the ingestion
commands (`create`, `update`, `research-sources`, and `pack create/eval/update`)
land in Phase 2.

Built on [`@kgpacks/packs`](../packs), [`@kgpacks/query`](../query), and
[`@kgpacks/db`](../db). See [docs/PLAN.md](../../docs/PLAN.md) for the porting
contract (command names, flags, and exit codes are preserved).

## Install / run

```sh
pnpm --filter @kgpacks/cli build
node packages/cli/dist/bin.js --help
# or, once linked on PATH:
wikigr --help
```

## Commands

```
wikigr [--packs-dir <dir>] <command>

  query <pack> <question> [-k, --k <n>] [--mode <vector|hybrid>]
                                 Query a pack and print ranked retrieval results.
  status                         Show the resolved packs directory + installed packs.
  pack install <archive.tar.gz>  Install a pack from a local gzip-compressed tarball.
  pack list                      List installed packs.
  pack info <pack>               Print a pack's full manifest.
  pack validate <pack>           Validate a pack's manifest.
  pack remove <pack>             Remove an installed pack.
```

All successful output is pretty-printed JSON on **stdout**. Errors print a
message to **stderr** and set a distinct exit code (below).

### `query` defaults

`-k` defaults to `5`; `--mode` defaults to `vector`.

## Packs-directory resolution

The install root is resolved in this order:

1. the global `--packs-dir <dir>` flag,
2. the `KGPACKS_PACKS_DIR` environment variable,
3. `<cwd>/data/packs` (the default layout, shared with `@kgpacks/mcp`).

## Exit codes

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| `0`  | Success                                              |
| `1`  | Generic / uncaught error                             |
| `2`  | Usage / argument-parse error                         |
| `3`  | Pack not found (unknown/invalid name or missing dir) |
| `4`  | Manifest or Cypher validation failure                |
| `5`  | Pack install failure                                 |
| `6`  | Query / retrieval runtime failure                    |

## Programmatic use

The package also exports a testable, dependency-injectable surface:

```ts
import { run, buildProgram } from '@kgpacks/cli';

// `run` resolves to the process exit code (it never calls process.exit):
const code = await run(['status'], { packsDir, io, runQuery });
```

`buildProgram` / `run` accept an output sink (`io`), a packs-directory override,
an environment/cwd, and a `runQuery` seam — so the heavy retrieval stack
(`@kgpacks/db` + `@kgpacks/query` + the embedding runtime) is loaded lazily by
the default runner and stays out of tests. See [docs/PLAN.md](../../docs/PLAN.md)
and [docs/monorepo.md](../../docs/monorepo.md) for the broader contract.
