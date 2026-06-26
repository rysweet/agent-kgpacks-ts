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
Build it yourself only if you need a custom slice or a fresher corpus.

## Build

```bash
pnpm -r build                                              # compile packages first

# A bounded, fast slice (recommended for a usable pack):
pnpm cve:build --src .scratch/cve/cves --year 2025 --limit 5000

# The comprehensive build (all ~360k records — a multi-hour batch):
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db
```

Flags (`scripts/build-cve-pack.mjs`):

| Flag      | Default                  | Meaning                               |
| --------- | ------------------------ | ------------------------------------- |
| `--src`   | (required)               | Directory tree of `CVE-*.json` files. |
| `--year`  | all                      | Restrict to one CVE year.             |
| `--limit` | all                      | Cap the number of records.            |
| `--out`   | `data/packs/cve/pack.db` | Output pack path (gitignored).        |
| `--batch` | `96`                     | Embedding batch size.                 |

It prints a JSON summary (`mapped`, `articles`, `sections`, `chunks`, `entities`,
`relationships`, `seconds`).

> **Comprehensive scale.** The builder **streams**: each batch is embedded,
> bulk-loaded via `createPackWriter` (one `UNWIND` per node/edge table), and
> discarded, so peak memory is a single batch (~9 GB on a 5k-record run) regardless
> of corpus size, and the pack is written incrementally. The remaining cost is CPU
> embedding (~10–15 short texts/sec on CPU), so the full ~360k corpus is an
> overnight batch — run it detached on a server. A single recent year (~30–45k
> records) is a substantial, coherent pack on its own. This is runnable batch
> tooling with bounded memory, not deferred work.

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

The round-trip (`release-pack.mjs` → `wikigr pack pull`) is covered end-to-end by
`packages/cli/test/pack-pull.test.ts`, which packages a fixture pack with the real
script, serves it over localhost, and verifies a byte-identical multi-part install.
