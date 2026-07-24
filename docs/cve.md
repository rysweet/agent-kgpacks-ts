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

### Mapping (`packages/ingestion/src/cve-adapter.ts`)

The TypeScript adapter is the sole mapping authority. The historical
`scripts/cve-source.mjs` entry point contains no mapping logic and delegates to
the compiled ingestion export.

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
peeled release `--corpus-commit`, `--corpus-date`, and separate `--corpus-tag`.
See [cve-corpus.md](cve-corpus.md) for options (`--tag`, `--dest`, `--max-bytes`,
`GITHUB_TOKEN`) and the security model. The full baseline is ~550 MB / ~360k
records; the delta asset is a much smaller recent-changes slice.

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
| `--batch`                  | `96`                     | Embedding batch size.                                                                    |
| `--resume` / `--no-resume` | auto                     | Resume from / ignore a build checkpoint ([docs/resumable-build.md](resumable-build.md)). |
| `--checkpoint-every`       | `50`                     | Batches between durable checkpoints (bounds crash re-work).                              |
| `--corpus-commit`          | sidecar                  | Full lowercase 40-character source commit; required without a sidecar.                   |
| `--corpus-date`            | sidecar                  | Real UTC source date in `YYYY-MM-DD` form; required without a sidecar.                   |
| `--corpus-tag`             | sidecar                  | Non-empty upstream release tag; required without a sidecar.                              |

`pnpm cve:fetch` writes `corpus-provenance.json` above the extracted source
tree. When present, this complete sidecar is authoritative: matching
`--corpus-*` flags are assertions, while conflicts, malformed fields, extra or
missing fields, and supplied/sidecar value mismatches fail before staging is
created or resumed. A manual source without the sidecar requires all three
flags. See the [canonical provenance contract](cve-corpus.md#provenance).

The build is **resumable and pipelined**: it checkpoints progress so an interrupted
run continues from the last checkpoint (`--resume`), and it overlaps embedding with
DB load so cores are not idle — see [docs/resumable-build.md](resumable-build.md).

It prints a JSON summary (`mapped`, `articles`, `sections`, `chunks`, `entities`,
`relationships`, `seconds`).

### Build an update-capable base

The schema-v2 full builder makes fresh CVE baselines eligible for immutable
incremental updates by writing the complete provenance schema: singleton
`PackMetadata`, canonical `ArticleSource` records, article/entity support,
`RelationSupport`, update-application support, required columns, and required
indexes. It generates the manifest from this durable state and runs complete
pack validation before publication.

Update-capable bases require live `ENTITY_RELATION` edges and the complete
schema-v2 provenance. Existing packs without exact source and support records
must be rebuilt from the corpus.

> **Comprehensive scale & performance.** The builder **streams**: each batch is
> embedded, bulk-loaded via `createPackWriter`, and discarded, so peak memory is a
> single batch regardless of corpus size. Edges are created with **PK-indexed
> Cypher** (single-`MATCH` inline create for `HAS_SECTION`/`HAS_CHUNK`, separate
> `MATCH` clauses elsewhere) so the load is **~linear**, not O(N²). The dominant
> remaining cost is CPU embedding (~10–15 texts/sec). The full ~360k corpus is an
> overnight batch — run it detached on a server.
>
> `ENTITY_RELATION` (Entity→Entity) edges are required for schema-v2 provenance
> validation. Building them remains the dominant finalization cost on the full
> corpus. The HNSW vector-index build is ~linear (a few minutes at full scale).

## Apply an incremental CVE delta

Incremental update is copy-on-write: it reads an eligible base, applies
strict-UTF-8 NDJSON operations in stable `cveId` order, completely validates a
new schema-v2 pack, and atomically publishes a distinct output directory.

```bash
wikigr update \
  --base data/releases/2026.06/cve \
  --delta .scratch/cve/delta.ndjson \
  --output data/releases/2026.07/cve \
  --version 2026.7.0
```

Canonical adapter payload bytes determine `added`, `modified`, and `unchanged`.
Omitted records remain present. Empty deltas are valid. Delete operations and
`REJECTED` CVEs reject the entire delta. The updater accepts no replacement
provenance flags: it completely validates the base corpus identity and preserves
that exact identity in the output. Resume rechecks the base, staging database,
and saved provenance digest before continuing.

See [the incremental CVE update how-to](howto/incremental-cve-update.md) for the
operational workflow and the
[incremental update reference](reference/incremental-update.md) for the exact
grammar, API, manifest, validation, resume, and publication contracts.

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
# Package data/packs/cve and publish to the manifest-derived immutable tag
node scripts/release-pack.mjs --pack cve

# Inspect the artifacts locally without uploading (writes parts + index to --out-dir)
node scripts/release-pack.mjs --pack cve --dry-run --out-dir /tmp/cve-rel
```

`release-pack.mjs` tars `manifest.json` + `pack.db` with `tar --format=ustar`
(plain ustar headers, exactly what the in-process installer parses), gzip-streams
it, and splits the stream into `--part-size` chunks (default 1900 MiB, safely
under GitHub's 2 GiB asset limit), writing each `cve.tar.gz.NNN` part and a
`cve.pack-release.json` index with per-part and overall SHA-256 sums. With `gh`
authenticated it creates/uploads to the release tag. Without `--tag`, the tag is
`<name>-v<manifest.version>`.

| Flag          | Default          | Meaning                                          |
| ------------- | ---------------- | ------------------------------------------------ |
| `--pack`      | (required)       | Pack directory name under `--packs-dir`.         |
| `--packs-dir` | `data/packs`     | Packs root.                                      |
| `--tag`       | manifest-derived | Immutable tag to create/upload to.               |
| `--repo`      | gh-resolved repo | `owner/repo` to publish to.                      |
| `--part-size` | `1900MiB`        | Max bytes per part (`B`/`KB`/`MB`/`GB`/`MiB`/…). |
| `--out-dir`   | temp dir         | Where parts + index are written.                 |
| `--dry-run`   | off              | Build artifacts; skip all `gh` calls.            |

### Versioned tags + provenance

The default immutable tag is `<name>-v<manifest.version>`. A dated tag is also
accepted when its derived SemVer exactly matches the manifest:

```bash
# Immutable version cve-2025.06 → index version 2025.6.0
node scripts/release-pack.mjs --pack cve --tag cve-2025.06
```

For schema-v2 packs, the script runs complete validation before archiving. It
creates a draft release, verifies the uploaded asset set, and publishes only
after verification. An existing exact asset set is a no-op; a mismatch fails
without replacing assets or moving a tag. Immutable publication does not update
the legacy mutable `packs` release. See
[immutable update release publication](pack-versioning.md#immutable-update-release-publication).

The builder (`build-cve-pack.mjs`) stamps **provenance** (corpus commit/date/tag,
embedding model, build date) into `manifest.json`; the release script mirrors it
into `cve.pack-release.json` and fills `build.date`. Supply the required full SHA
and real UTC date with `--corpus-commit` / `--corpus-date`, plus `--corpus-tag`
when building from a release. `pnpm cve:fetch` prints these pre-filled from the
source release (see [cve-corpus.md](cve-corpus.md)). See
[docs/pack-versioning.md](pack-versioning.md) for the tag scheme and the full
provenance field reference.

The round-trip (`release-pack.mjs` → `wikigr pack pull`) is covered end-to-end by
`packages/cli/test/pack-pull.test.ts`, which packages a fixture pack with the real
script, serves it over localhost, and verifies a byte-identical multi-part install.
