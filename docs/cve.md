# CVE knowledge pack

Builds a knowledge pack from the **MITRE / CVE Program** vulnerability corpus
([github.com/CVEProject/cvelistV5](https://github.com/CVEProject/cvelistV5),
CVE Record Format 5.1 — the authoritative feed published by the MITRE-run CVE
Program). The result is queryable through the exact same read path as every other
pack (`@kgpacks/query`, `wikigr query`, the backend, the MCP server).

## Why this is a different ingestion path

CVE records are **already structured JSON**, so the builder does **not** use the
web-crawl + LLM-extraction pipeline (`buildPack`). Instead it maps each record
deterministically onto the platform's document/graph model and reuses only the
embedding + load machinery:

```
CVE 5.1 JSON ─▶ cveToGraph() ─▶ Article + Entities + Relationships
             ─▶ BGE embed (sections + chunks) ─▶ loadPack() ─▶ LadybugDB pack
```

No LLM is involved, so building is a throughput problem (embed + load), not a
per-record latency problem — which is what makes a _comprehensive_ build feasible.

### Mapping (`scripts/cve-source.mjs`)

| Source field                                                 | Graph element                                       |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `cveMetadata.cveId`                                          | `Article` (one per CVE) + `vulnerability` entity    |
| `cna.title` + `cna.descriptions` + affected + CWE + severity | the article's lead `Section` (embedded text)        |
| `cna/adp.problemTypes[].cweId`                               | `weakness` entity + `CVE -has_weakness-> CWE`       |
| `cna.affected[].product`                                     | `product` entity + `CVE -affects-> product`         |
| `cna.affected[].vendor`                                      | `organization` entity + `product -made_by-> vendor` |
| `cna/adp.metrics[]` (CVSS)                                   | severity label in the embedded text                 |

Entities dedupe by name in the loader, so shared CWEs, vendors and products knit
the per-CVE articles into one cross-referenced vulnerability graph. Rejected
records and records with no English description are skipped.

## Get the corpus

The corpus is published as **GitHub Release assets** on
[CVEProject/cvelistV5](https://github.com/CVEProject/cvelistV5). Fetch it with the
built-in integration, which resolves the latest release, downloads + double-unzips
the right asset, and records provenance:

```bash
pnpm cve:fetch                     # full corpus -> .scratch/cve/extracted/cves
pnpm cve:fetch --kind delta        # small "recent changes" corpus (fast to try)
```

It prints the exact `pnpm cve:build …` command to run next, pre-filled with the
release `--corpus-commit`/`--corpus-date` so the built pack is provenance-stamped.
See [cve-corpus.md](cve-corpus.md) for options (`--tag`, `--dest`, `--max-bytes`,
`GITHUB_TOKEN`) and the security model. The full baseline is ~550 MB / ~360k
records; the delta asset is a much smaller recent-changes slice.

The delta asset can be converted to stable NDJSON and applied to a completed
schema-v2 pack with `wikigr update`; see
[cve-corpus.md](cve-corpus.md) and [Incremental updates](#incremental-updates).

## Download the prebuilt pack (no build required)

The full CVE pack is published as a multi-part **GitHub Release** artifact, so you
can install it without rebuilding from the corpus:

```bash
wikigr pack pull cve            # download + integrity-check + install
wikigr query cve "remote code execution in a Joomla extension" -k 5
```

The pack is split into `<2 GiB` parts (GitHub's per-asset limit) described by a
`cve.pack-release.json` index; `pack pull` verifies each part's SHA-256 and the
overall archive checksum, then streams the reassembled `tar.gz` through the
streaming installer (bounded memory, full tar-entry validation, atomic install).
Build it yourself only if you need a custom slice or a fresher corpus. To **use**
the published pack, see [using-the-cve-pack.md](using-the-cve-pack.md).

## Build

```bash
pnpm -r build                                              # compile packages first

# A bounded, fast slice (recommended for a usable pack):
pnpm cve:build --src .scratch/cve/extracted/cves --year 2025 --limit 5000

# The comprehensive build (all ~360k records — a multi-hour batch):
pnpm cve:build --src .scratch/cve/extracted/cves --out data/packs/cve/pack.db
```

Flags (`scripts/build-cve-pack.mjs`):

| Flag                       | Default                  | Meaning                                                                                  |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `--src`                    | (required)               | Directory tree of `CVE-*.json` files.                                                    |
| `--year`                   | all                      | Restrict to one CVE year.                                                                |
| `--limit`                  | all                      | Cap the number of records.                                                               |
| `--out`                    | `data/packs/cve/pack.db` | Output pack path (gitignored).                                                           |
| `--version`                | `1.0.0`                  | Immutable manifest version.                                                              |
| `--batch`                  | `96`                     | Embedding batch size.                                                                    |
| `--with-entity-relations`  | off (skipped)            | Build `ENTITY_RELATION` edges (see the performance note below).                          |
| `--resume` / `--no-resume` | auto                     | Resume from / ignore a build checkpoint ([docs/resumable-build.md](resumable-build.md)). |
| `--checkpoint-every`       | `50`                     | Batches between durable checkpoints (bounds crash re-work).                              |

The build is **resumable and pipelined**: it checkpoints progress so an interrupted
run continues from the last checkpoint (`--resume`), and it overlaps embedding with
DB load so cores are not idle — see [docs/resumable-build.md](resumable-build.md).

It prints a JSON summary (`mapped`, `articles`, `sections`, `chunks`, `entities`,
`relationships`, `seconds`).

Pass `--with-entity-relations` when producing a base for incremental updates.
That mode publishes schema-v2 source payloads, article/entity support, relation
support, checksums, a content digest, and a deterministic build ID. Builds that
skip live entity relations remain readable legacy packs but are intentionally
rejected as update bases.

Completed output directories are immutable. The builder refuses to replace a
directory that already contains `manifest.json`; choose a new versioned output
directory for each corpus snapshot.

## Incremental updates

```bash
wikigr update --base data/packs/cve-2026.06 \
  --delta .scratch/cve/delta.ndjson \
  --output data/packs/cve-2026.07 \
  --version 2026.7.0
```

The base remains read-only. Existing records are compared by exact source-payload
SHA-256 after the CVE adapter emits compact JSON (transport whitespace is ignored):
equal records are preserved, changed records replace their prior
article-supported graph, and absent records remain. Duplicate keys and explicit
deletes fail. Shared entities and relations survive while another article still
supports them. Generated indexes are rebuilt and the staged output is
comprehensively validated before atomic publication. Use `wikigr update --resume
<output>.work` only for interrupted incremental work; it is unrelated to
`pnpm cve:build --resume`.

> **Comprehensive scale & performance.** The builder **streams**: each batch is
> embedded, bulk-loaded via `createPackWriter`, and discarded, so peak memory is a
> single batch regardless of corpus size. Edges are created with **PK-indexed
> Cypher** (single-`MATCH` inline create for `HAS_SECTION`/`HAS_CHUNK`, separate
> `MATCH` clauses elsewhere) so the load is **~linear**, not O(N²). The dominant
> remaining cost is CPU embedding (~10–15 texts/sec). The full ~360k corpus is an
> overnight batch — run it detached on a server.
>
> `ENTITY_RELATION` (Entity→Entity) edges are **skipped by default**: no
> retrieval/graph read path traverses them and building them is super-linear at
> scale (it dominated finalize on the full corpus — hours). Pass
> `--with-entity-relations` to include them. The HNSW vector-index build in
> finalize is ~linear (a few minutes at full scale).

## Query

The CVE pack is read like any other pack:

```bash
wikigr query cve "SQL injection in a Joomla extension" -k 5 --mode hybrid
```

Validated live (delta corpus): vector retrieval surfaces the right CVEs
(cosine ≈ 0.83) and the Copilot-SDK synthesis returns a grounded, `doc:`-cited
answer (correct CWE, CVSS and affected product).

## Publish a pack as a release artifact

Packs are large binary databases and are **never committed to git**. Publish a
built pack as a multi-part, integrity-checked GitHub Release artifact that
`wikigr pack pull` consumes:

```bash
# Package data/packs/cve and upload to the manifest-derived `cve-v<version>` release
node scripts/release-pack.mjs --pack cve

# Inspect the artifacts locally without uploading (writes parts + index to --out-dir)
node scripts/release-pack.mjs --pack cve --dry-run --out-dir /tmp/cve-rel
```

`release-pack.mjs` tars `manifest.json` + `pack.db` with `tar --format=ustar`
(plain ustar headers, exactly what the in-process installer parses), gzip-streams
it, and splits the stream into `--part-size` chunks (default 1900 MiB, safely
under GitHub's 2 GiB asset limit), writing each `cve.tar.gz.NNN` part and a
`cve.pack-release.json` index with per-part and overall SHA-256 sums. With `gh`
authenticated it creates/uploads to the release tag (`--tag`, default
`<name>-v<manifest-version>`).

| Flag          | Default             | Meaning                                          |
| ------------- | ------------------- | ------------------------------------------------ |
| `--pack`      | (required)          | Pack directory name under `--packs-dir`.         |
| `--packs-dir` | `data/packs`        | Packs root.                                      |
| `--tag`       | `<name>-v<version>` | Immutable release tag derived from the manifest. |
| `--repo`      | gh-resolved repo    | `owner/repo` to publish to.                      |
| `--part-size` | `1900MiB`           | Max bytes per part (`B`/`KB`/`MB`/`GB`/`MiB`/…). |
| `--out-dir`   | temp dir            | Where parts + index are written.                 |
| `--dry-run`   | off                 | Build artifacts; skip all `gh` calls.            |

### Versioned tag convention + provenance

A dated tag identifies one immutable release. Its derived SemVer must exactly
match the manifest version:

```bash
# Tag cve-2025.06 requires manifest version 2025.6.0
node scripts/release-pack.mjs --pack cve --tag cve-2025.06
```

The builder (`build-cve-pack.mjs`) stamps **provenance** (corpus commit/date,
embedding model, deterministic build date) into `manifest.json`; the release script mirrors it
into `cve.pack-release.json`. Override the
corpus fields with `--corpus-commit` / `--corpus-date` — `pnpm cve:fetch` prints
these pre-filled from the source release (see [cve-corpus.md](cve-corpus.md)).

The script requires comprehensive schema-v2 validation before publication,
creates deterministic tar metadata, uploads to a draft without `--clobber`, and
publishes only after upload. An exact existing release is a no-op; mismatched tags
or assets fail without replacement. Publishing never mutates another tag. See
[docs/pack-versioning.md](pack-versioning.md) for the tag scheme and the full
provenance field reference.

The round-trip (`release-pack.mjs` → `wikigr pack pull`) is covered end-to-end by
`packages/cli/test/pack-pull.test.ts`, which packages a fixture pack with the real
script, serves it over localhost, and verifies a byte-identical multi-part install.
