# @kgpacks/cli

The `wikigr` command-line interface — a Commander port of the upstream CLI. It
covers both halves of the platform:

- **RUNTIME** (Phase 1): querying and pack management —
  `query`, `status`, and `pack { install, list, info, validate, remove }`.
- **INGESTION** (Phase 2): building and evaluating packs —
  `create`, `update`, `research-sources`, and `pack { create, eval, update }`.

Built on [`@kgpacks/packs`](../packs), [`@kgpacks/query`](../query), and
[`@kgpacks/db`](../db) for the runtime side, and on
[`@kgpacks/ingestion`](../ingestion) (`buildPack`) and [`@kgpacks/eval`](../eval)
(`runEval`) for the ingestion side. The heavy write-side stack (HTTP fetch, the
embedding model, the LLM extractor/judge) is loaded **lazily**, only when an
ingestion command actually runs — so constructing the program or running a
runtime command never pulls in the model runtime.

See [docs/PLAN.md](../../docs/PLAN.md) for the porting contract. The **runtime**
command names, flags, and exit codes are preserved from the upstream Python CLI;
the Phase-2 **ingestion/eval** commands extend that surface, reusing the same
one-exit-code-per-failure-class convention (see [Exit codes](#exit-codes)).

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

RUNTIME
  query <pack> <question> [-k, --k <n>] [--mode <vector|hybrid>]
                                 Query a pack and print ranked retrieval results.
  status                         Show the resolved packs directory + installed packs.
  pack install <archive.tar.gz>  Install a pack from a local gzip-compressed tarball.
  pack list                      List installed packs.
  pack info <pack>               Print a pack's full manifest.
  pack validate <pack>           Validate a pack's manifest.
  pack remove <pack>             Remove an installed pack.

INGESTION
  create  --pack <name> (--seeds <url...> | --config <file>)
          [--max-depth <n>] [--max-articles <n>]
          [--chunk-size <n>] [--chunk-overlap <n>]
                                 Build a new pack database from seed URLs / a config.
  update  --pack <name> (--seeds <url...> | --config <file>)
          [--max-depth <n>] [--max-articles <n>]
          [--chunk-size <n>] [--chunk-overlap <n>]
                                 Resume / extend an existing pack's graph.
  research-sources --seeds <url...> [--max-depth <n>] [--max-articles <n>]
                                 Discover / seed candidate source URLs for a domain.
  pack create  ...               Alias of `create`, under the `pack` group.
  pack eval    --pack <name> [--questions <dir>] [--sample <full|stratified>]
               [--per-pack <n>] [--judge-model <id>]
                                 Run @kgpacks/eval over a pack (with-pack vs training-only).
  pack update  ...               Alias of `update`, under the `pack` group.
```

All successful output is pretty-printed JSON on **stdout**. Errors print a
message to **stderr** and set a distinct exit code (see [Exit codes](#exit-codes)).

### `query` defaults

`-k` defaults to `5`; `--mode` defaults to `vector`.

## Ingestion commands

The ingestion commands wrap [`@kgpacks/ingestion`](../ingestion)'s `buildPack`
pipeline (`fetch → clean/sectionize → extract → chunk → embed → load → expand`)
and [`@kgpacks/eval`](../eval)'s `runEval`. They write into / read from the
resolved packs directory exactly like the runtime commands (see
[Packs-directory resolution](#packs-directory-resolution)).

> **Dual surface.** `create` / `update` are mounted **both** at the top level and
> under the `pack` group (`pack create` / `pack update`). The two mounts share one
> implementation and one seam, so `wikigr create …` and `wikigr pack create …` are
> behaviourally identical — they differ only in where they appear in `--help`.

### `create` — build a new pack

```
wikigr [--packs-dir <dir>] create --pack <name> (--seeds <url...> | --config <file>)
       [--max-depth <n>] [--max-articles <n>] [--chunk-size <n>] [--chunk-overlap <n>]
```

Builds a brand-new pack database at `<packs-dir>/<name>/pack.db` from the supplied
seeds (or a [config file](#config-file)), running the full ingestion pipeline. At
least one seed source is required: pass `--seeds` (one or more HTTPS URLs) **or**
`--config`. Explicit flags override matching keys read from `--config`.

| Flag                  | Required | Default           | Maps to `BuildPackConfig`                   |
| --------------------- | -------- | ----------------- | ------------------------------------------- |
| `--pack <name>`       | yes      | —                 | pack directory / `dbPath`                   |
| `--seeds <url...>`    | one of   | —                 | `seeds`                                     |
| `--config <file>`     | one of   | —                 | `seeds`, `maxDepth`, `maxArticles`, `chunk` |
| `--max-depth <n>`     | no       | `1`               | `maxDepth`                                  |
| `--max-articles <n>`  | no       | `50`              | `maxArticles`                               |
| `--chunk-size <n>`    | no       | `512` (ingestion) | `chunk.size`                                |
| `--chunk-overlap <n>` | no       | `64` (ingestion)  | `chunk.overlap`                             |

On success it prints **bounded JSON counts** (not the full arrays) and exits `0`:

```json
{
  "pack": "ada",
  "dbPath": "/abs/path/data/packs/ada/pack.db",
  "articles": 12,
  "sections": 84,
  "chunks": 311,
  "entities": 57,
  "relationships": 73,
  "links": 19
}
```

Example:

```sh
wikigr create --pack ada \
  --seeds https://en.wikipedia.org/wiki/Ada_Lovelace \
          https://en.wikipedia.org/wiki/Charles_Babbage \
  --max-depth 1 --max-articles 25
```

### `update` — resume / extend a pack

```
wikigr [--packs-dir <dir>] update --pack <name> (--seeds <url...> | --config <file>)
       [--max-depth <n>] [--max-articles <n>] [--chunk-size <n>] [--chunk-overlap <n>]
```

Opens an **existing** pack and re-runs the pipeline with additional seeds,
extending its graph in place. The pack must already exist — an unknown pack exits
`3` (pack not found). Resume/extend semantics come from `buildPack`'s title-level
dedup: already-loaded articles are skipped, new ones are appended. Flags, config
handling, and the JSON-counts output are identical to [`create`](#create--build-a-new-pack)
(the counts reflect what this run loaded).

```sh
wikigr update --pack ada --seeds https://en.wikipedia.org/wiki/Analytical_Engine
```

### `research-sources` — discover candidate URLs

```
wikigr research-sources --seeds <url...> [--max-depth <n>] [--max-articles <n>]
```

Performs a **fetch-only** bounded breadth-first crawl from the seeds (no extract,
embed, or load) and reports the same-domain article URLs it discovers — a cheap way
to scout a domain before committing to a full `create`. `--seeds` is required;
`--max-depth` (default `1`) and `--max-articles` (default `50`) bound the crawl.

The reported `discovered` list contains only **newly found** URLs. Internally the
`discoverSources` seam runs `expandFromSeeds` (which returns the seed articles at
depth `0` alongside their expansion) and then **drops the seeds**, so a seed URL
never appears in its own `discovered` output — the seeds are echoed back separately
under the `seeds` key.

Output (exit `0`):

```json
{
  "seeds": ["https://en.wikipedia.org/wiki/Ada_Lovelace"],
  "discovered": [
    "https://en.wikipedia.org/wiki/Charles_Babbage",
    "https://en.wikipedia.org/wiki/Analytical_Engine"
  ],
  "count": 2
}
```

### `pack eval` — evaluate a pack

```
wikigr pack eval --pack <name> [--questions <dir>] [--sample <full|stratified>]
                 [--per-pack <n>] [--judge-model <id>]
```

Runs [`@kgpacks/eval`](../eval) over an installed pack, scoring the **with-pack**
arm (full retrieve + synthesize) against the **training-only** arm (no pack
context) with a single LLM judge held constant across both arms. The pack must
exist — otherwise exit `3`.

| Flag                 | Required | Default                                                  | Meaning                                       |
| -------------------- | -------- | -------------------------------------------------------- | --------------------------------------------- |
| `--pack <name>`      | yes      | —                                                        | pack directory to evaluate                    |
| `--questions <dir>`  | no       | the packs dir (reads `<dir>/<pack>/eval_questions.json`) | question-loader base directory                |
| `--sample <mode>`    | no       | `full`                                                   | `full` \| `stratified` (`SampleOptions.mode`) |
| `--per-pack <n>`     | no       | `3`                                                      | questions/pack in `stratified` mode           |
| `--judge-model <id>` | no       | `claude-opus-4.1`                                        | judge model id (overriding it re-baselines)   |

It prints the full [`EvalReport`](../eval) as JSON (per-question verdicts, per-arm
aggregates, and the with-pack-vs-training-only comparison) and exits `0`:

```json
{
  "results": [
    /* one entry per scored question */
  ],
  "arms": {
    "withPack": { "name": "with-pack", "accuracy": 0.83, "meanScore": 0.79, "count": 12 },
    "trainingOnly": { "name": "training-only", "accuracy": 0.5, "meanScore": 0.52, "count": 12 }
  },
  "comparison": { "deltaAccuracy": 0.33, "wins": 5, "losses": 1, "ties": 6, "winRate": 0.83 },
  "sampled": 12,
  "total": 40
}
```

```sh
wikigr pack eval --pack ada --sample stratified --per-pack 5
```

## Config file

`--config <file>` reads a JSON document that is a subset of `@kgpacks/ingestion`'s
[`BuildPackConfig`](../ingestion). Recognized keys:

```json
{
  "seeds": ["https://en.wikipedia.org/wiki/Ada_Lovelace"],
  "maxDepth": 1,
  "maxArticles": 50,
  "chunk": { "size": 512, "overlap": 64 }
}
```

- Only the data-plane keys above are read; the injectable seams (`fetcher`,
  `embedder`, `extractor`, `transport`, `connection`) are **not** configurable from
  the file — the CLI wires the production defaults (and tests inject their own).
- **Explicit CLI flags win.** When a key appears in both the config file and on the
  command line, the flag value is used (`--seeds` is merged/overridden, the bounds
  and chunk flags override their config counterparts).
- A missing seed source (no `--seeds` and no `seeds` in `--config`), an
  unparseable integer flag, or any unknown flag is a **usage error** (exit `2`).

## Packs-directory resolution

The install root is resolved in this order:

1. the global `--packs-dir <dir>` flag,
2. the `KGPACKS_PACKS_DIR` environment variable,
3. `<cwd>/data/packs` (the default layout, shared with `@kgpacks/mcp`).

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | Success                                                      |
| `1`  | Generic / uncaught error                                     |
| `2`  | Usage / argument-parse error                                 |
| `3`  | Pack not found (unknown/invalid name or missing dir)         |
| `4`  | Manifest or Cypher validation failure                        |
| `5`  | Pack install failure                                         |
| `6`  | Query / retrieval runtime failure                            |
| `7`  | Ingestion failure (`create` / `update` / `research-sources`) |
| `8`  | Evaluation failure (`pack eval`)                             |

Codes are stable and part of the package's public contract. Failures are mapped
by the thrown error's **name** (the mapper never imports the heavy write-side
packages):

- `7` ← `IngestionError`, `BlockedUrlError`, `FetchError`, `ExtractionError`
  (from [`@kgpacks/ingestion`](../ingestion)).
- `8` ← `EvalError` (from [`@kgpacks/eval`](../eval)).

Codes `0`–`6` are the runtime contract carried over from the upstream Python CLI.
Codes `7` and `8` are **new in Phase 2**: rather than folding ingestion/eval
failures into the generic `1`, they extend the same one-code-per-failure-class
convention to the write-side surfaces. They are appended to the existing
`NAME_TO_CODE` table without disturbing the preserved runtime codes.

## Programmatic use

The package also exports a testable, dependency-injectable surface:

```ts
import { run, buildProgram } from '@kgpacks/cli';

// `run` resolves to the process exit code (it never calls process.exit):
const code = await run(['status'], { packsDir, io, runQuery });
```

`buildProgram` / `run` accept an output sink (`io`), a packs-directory override,
an environment/cwd, and a set of **injectable seams** so the heavy stacks stay out
of tests and are loaded lazily by the production defaults otherwise:

| Seam (`BuildProgramOptions`)                                                                     | Default                                                                                 | Used by                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `runQuery`                                                                                       | lazy `@kgpacks/db` + `@kgpacks/query`                                                   | `query`                                            |
| `buildPack(config): Promise<BuildPackResult>`                                                    | lazy `@kgpacks/ingestion` `buildPack`                                                   | `create`, `update` (`pack create` / `pack update`) |
| `discoverSources({ seeds, maxDepth, maxArticles }): Promise<string[]>`                           | lazy ingestion fetch + `expandFromSeeds`, with the seed URLs filtered out of the result | `research-sources`                                 |
| `evalPack({ packDir, packId, sample, perPack, judgeModel, questionsDir? }): Promise<EvalReport>` | lazy `@kgpacks/eval` `runEval` (+ `@kgpacks/query` / `@kgpacks/agent`)                  | `pack eval`                                        |

Because the seams are overridable, the whole surface runs **offline** in tests.
For example, an ingestion test injects a `buildPack` wrapper that supplies mock
`fetcher` / `embedder` / `extractor` seams and a caller-owned in-memory
`Connection`, then asserts the loaded counts and exit code:

```ts
import { run } from '@kgpacks/cli';
import { buildPack as realBuildPack } from '@kgpacks/ingestion';
import { Database } from '@kgpacks/db';

const db = new Database(':memory:');
const connection = db.connect();

const code = await run(['create', '--pack', 'tiny', '--seeds', 'https://example.test/Seed'], {
  io,
  packsDir,
  buildPack: (config) => realBuildPack({ ...config, fetcher, embedder, extractor, connection }),
});
// code === 0; query `connection` to assert the articles/sections were loaded.
```

`discoverSources` and `evalPack` are injectable the same way. See
[docs/PLAN.md](../../docs/PLAN.md) and [docs/monorepo.md](../../docs/monorepo.md)
for the broader contract.
