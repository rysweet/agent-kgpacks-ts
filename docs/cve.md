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

> **Comprehensive scale.** The full corpus is ~360k records; embedding plus the
> per-row graph load make it a long (multi-hour) batch — run it detached on a
> server. A single recent year (~30–45k records) is a substantial, coherent pack
> on its own. This is runnable batch tooling, not deferred work.

## Query

The CVE pack is read like any other pack:

```bash
wikigr query cve "SQL injection in a Joomla extension" -k 5 --mode hybrid
```

Validated live (delta corpus): vector retrieval surfaces the right CVEs
(cosine ≈ 0.83) and the Copilot-SDK synthesis returns a grounded, `doc:`-cited
answer (correct CWE, CVSS and affected product).
