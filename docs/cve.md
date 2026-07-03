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

Download and unzip the nightly all-CVEs release (the asset is double-zipped):

```bash
mkdir -p .scratch/cve && cd .scratch/cve
curl -sL -o all.zip.zip \
  "$(curl -s https://api.github.com/repos/CVEProject/cvelistV5/releases/latest \
     | grep -o 'https://[^"]*all_CVEs[^"]*\.zip\.zip')"
unzip -q all.zip.zip               # -> cves.zip  (~360k records)
unzip -q cves.zip                  # -> cves/<year>/<bucket>/CVE-*.json
```

For a smaller, faster corpus use the much smaller `*_delta_CVEs_*.zip` asset
instead (recent changes only, ~1k records).

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
pnpm cve:build --src .scratch/cve/cves --year 2025 --limit 5000

# The comprehensive build (all ~360k records — a multi-hour batch):
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db
```

Flags (`scripts/build-cve-pack.mjs`):

| Flag                       | Default                  | Meaning                                                                                  |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `--src`                    | (required)               | Directory tree of `CVE-*.json` files.                                                    |
| `--year`                   | all                      | Restrict to one CVE year.                                                                |
| `--limit`                  | all                      | Cap the number of records.                                                               |
| `--out`                    | `data/packs/cve/pack.db` | Output pack path (gitignored).                                                           |
| `--batch`                  | `96`                     | Embedding batch size.                                                                    |
| `--with-entity-relations`  | off (skipped)            | Build `ENTITY_RELATION` edges (see the performance note below).                          |
| `--resume` / `--no-resume` | auto                     | Resume from / ignore a build checkpoint ([docs/resumable-build.md](resumable-build.md)). |
| `--checkpoint-every`       | `50`                     | Batches between durable checkpoints (bounds crash re-work).                              |

The build is **resumable and pipelined**: it checkpoints progress so an interrupted
run continues from the last checkpoint (`--resume`), and it overlaps embedding with
DB load so cores are not idle — see [docs/resumable-build.md](resumable-build.md).

It prints a JSON summary (`mapped`, `articles`, `sections`, `chunks`, `entities`,
`relationships`, `seconds`).

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
# Package data/packs/cve (manifest.json + pack.db) and upload to the `packs` release
node scripts/release-pack.mjs --pack cve

# Inspect the artifacts locally without uploading (writes parts + index to --out-dir)
node scripts/release-pack.mjs --pack cve --dry-run --out-dir /tmp/cve-rel
```

`release-pack.mjs` tars `manifest.json` + `pack.db` with `tar --format=ustar`
(plain ustar headers, exactly what the in-process installer parses), gzip-streams
it, and splits the stream into `--part-size` chunks (default 1900 MiB, safely
under GitHub's 2 GiB asset limit), writing each `cve.tar.gz.NNN` part and a
`cve.pack-release.json` index with per-part and overall SHA-256 sums. With `gh`
authenticated it creates/uploads to the release tag (`--tag`, default `packs`).

| Flag          | Default          | Meaning                                          |
| ------------- | ---------------- | ------------------------------------------------ |
| `--pack`      | (required)       | Pack directory name under `--packs-dir`.         |
| `--packs-dir` | `data/packs`     | Packs root.                                      |
| `--tag`       | `packs`          | Release tag to create/upload to.                 |
| `--repo`      | gh-resolved repo | `owner/repo` to publish to.                      |
| `--part-size` | `1900MiB`        | Max bytes per part (`B`/`KB`/`MB`/`GB`/`MiB`/…). |
| `--out-dir`   | temp dir         | Where parts + index are written.                 |
| `--dry-run`   | off              | Build artifacts; skip all `gh` calls.            |

### Versioned tags + provenance

Prefer an **immutable, dated tag** over clobbering `packs` on every rebuild — the
script publishes to the dated tag and also moves the stable `packs` latest-pointer
to the same assets, so `wikigr pack pull cve` (default `packs`) keeps working:

```bash
# Immutable version cve-2025.06 → index version 2025.6.0, + updates the packs pointer
node scripts/release-pack.mjs --pack cve --tag cve-2025.06
```

The builder (`build-cve-pack.mjs`) stamps **provenance** (corpus commit/date,
embedding model, build date) into `manifest.json`; the release script mirrors it
into `cve.pack-release.json` and fills `build.date`. Override the corpus fields
with `--corpus-commit` / `--corpus-date`. See
[docs/pack-versioning.md](pack-versioning.md) for the tag scheme and the full
provenance field reference.

The round-trip (`release-pack.mjs` → `wikigr pack pull`) is covered end-to-end by
`packages/cli/test/pack-pull.test.ts`, which packages a fixture pack with the real
script, serves it over localhost, and verifies a byte-identical multi-part install.
