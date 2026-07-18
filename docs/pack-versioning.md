# Pack release versioning & provenance

Published knowledge packs are **versioned** and carry **provenance** — a record of
exactly which corpus, embedding model, and build produced them. This lets you pin
a reproducible pack, audit where a pack came from, and roll forward or back without
ambiguity.

This document covers the release-tag scheme, the provenance fields written into
`manifest.json` and the `<name>.pack-release.json` index, and how `wikigr pack
pull` selects a version.

## Release tags: immutable versions + a stable "latest" pointer

Packs are published to GitHub Releases (see [docs/cve.md](cve.md)). Instead of
clobbering a single `packs` tag on every rebuild, each build is published under an
**immutable, dated version tag**, and the `packs` tag is kept as a **stable pointer
to the latest** version:

| Tag             | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cve-YYYY.MM`   | An **immutable** release of the CVE pack built in that month (e.g. `cve-2025.06`). Never overwritten.                                   |
| `cve-YYYY.MM.N` | A second/third rebuild in the same month (`N` starts at `0`), still immutable.                                                          |
| `packs`         | The **stable latest** pointer: always the newest published version's assets. Backwards-compatible with existing `wikigr pack pull cve`. |

Pack **manifest** `version` fields use a **SemVer 2.0** string derived from the
tag, so `wikigr pack info cve` and the registry's version comparison (see
[`@kgpacks/packs` versioning](packages/packs.md)) order releases correctly.

The planned schema-v2 incremental API requires the intersection of SemVer 2.0
and the filesystem-safe token constraint
`^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$`. Values such as `2026.7.0` satisfy both.
A target version must differ from its base version.

> **Tag vs. version — the month is _not_ zero-padded in the version.** The git
> **tag** zero-pads the month for readable, lexically-sortable tags
> (`cve-2025.06`). The manifest **version** must omit that pad — SemVer 2.0 forbids
> leading zeros in the numeric core, so `2025.06.0` is **invalid** and is rejected
> by `@kgpacks/packs`'s validator. The tag `cve-2025.06` therefore maps to version
> `2025.6.0`, and `cve-2025.06.1` to `2025.6.1`. Numeric comparison still orders
> months correctly (`2025.6.0` < `2025.11.0`).

## Pull a specific version

`wikigr pack pull cve` defaults to the `packs` tag (latest), unchanged. To pin an
immutable version, pass its tag:

```bash
wikigr pack pull cve                       # latest (the `packs` pointer)
wikigr pack pull cve --tag cve-2025.06      # pinned, immutable version
wikigr pack pull cve --tag cve-2025.06.1    # a specific rebuild
```

After install, verify what you got:

```bash
wikigr pack info cve      # prints version + full provenance block
```

## Provenance

Every published pack records **how it was built** in two places, written
identically so they can be cross-checked:

1. the pack's `manifest.json` (`provenance` object), and
2. the `<name>.pack-release.json` release index (`provenance` object).

### Fields

| Field                  | Example                     | Meaning                                                            |
| ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| `corpus.name`          | `"cvelistV5"`               | Source corpus identifier.                                          |
| `corpus.commit`        | `"a1b2c3d4…"`               | The exact upstream commit SHA the records were built from.         |
| `corpus.date`          | `"2025-06-14"`              | Publish/snapshot date of that corpus revision (UTC, `YYYY-MM-DD`). |
| `embedding.model`      | `"Xenova/bge-base-en-v1.5"` | The BGE model id used to embed every record (deterministic).       |
| `embedding.dimensions` | `768`                       | Embedding vector length.                                           |
| `build.date`           | `"2025-06-15T04:22:10Z"`    | When the pack was built (UTC, ISO-8601).                           |
| `build.tool_version`   | `"agent-kgpacks-ts@0.0.0"`  | The builder version that produced the pack.                        |

Any field whose value cannot be determined at build time is written as the string
`"unknown"` rather than omitted, so the shape is stable and audits can flag gaps.

### Example `manifest.json`

```jsonc
{
  "name": "cve",
  "version": "2025.6.0",
  "description": "Full CVE knowledge pack (MITRE/CVE Program corpus).",
  "graph_stats": {
    "articles": 343007,
    "entities": 435051,
    "size_mb": 4915.2,
  },
  "provenance": {
    "corpus": {
      "name": "cvelistV5",
      "commit": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "date": "2025-06-14",
    },
    "embedding": {
      "model": "Xenova/bge-base-en-v1.5",
      "dimensions": 768,
    },
    "build": {
      "date": "2025-06-15T04:22:10Z",
      "tool_version": "agent-kgpacks-ts@0.0.0",
    },
  },
}
```

### Example `cve.pack-release.json` (index)

The multi-part index gains the same `provenance` block alongside the existing
integrity fields:

```jsonc
{
  "name": "cve",
  "version": "2025.6.0",
  "format": "tar.gz-multipart-v1",
  "createdAt": "2025-06-15T04:30:00Z",
  "sha256": "…", // overall archive checksum
  "totalBytes": 4084862976,
  "partSize": 1992294400,
  "provenance": {
    /* identical to the manifest block above */
  },
  "parts": [
    { "file": "cve.tar.gz.000", "bytes": 1992294400, "sha256": "…" },
    { "file": "cve.tar.gz.001", "bytes": 1992294400, "sha256": "…" },
    { "file": "cve.tar.gz.002", "bytes": 100274176, "sha256": "…" },
  ],
}
```

> Provenance is **validated on load** by the manifest schema
> ([`@kgpacks/packs`](packages/packs.md)): each field, when present, must be a
> string. As with the rest of the manifest, dangerous keys
> (`__proto__`, `constructor`, `prototype`) are stripped when the object is
> rebuilt, so untrusted release JSON cannot pollute prototypes.

This is structural validation only. `validateManifest` does not open
`pack.db` or prove that provenance is true. For a schema-v2 pack,
`validateKnowledgePack` and `wikigr pack validate` compare every provenance,
identity, lineage, update, count, and file field against database and
filesystem authority. See
[validation boundaries](reference/incremental-update.md#validation-boundaries).

## Schema-v2 identity and lineage

An update-capable pack stores identity and provenance in the singleton
LadybugDB `PackMetadata` record. `manifest.json` is generated from that durable
record and cross-validated; it is not an independent authority.

The deterministic `buildId` covers the logical pack ID, target version, base
content digest, semantic delta ID, and identity-affecting
schema/adapter/extractor/tool versions. The raw delta-file SHA-256 remains
separate transport provenance. The complete update-capable manifest example,
including lineage, update records and all three counts, exact whole-pack
statistics, payload byte sizes/checksums, and `contentDigest`, is in the
[schema-v2 manifest reference](reference/incremental-update.md#schema-v2-manifest).

Schema-v2 directories contain only `pack.db` and `manifest.json`.

## Immutable update release publication

Incremental pack publication uses an explicit immutable release tag derived
from the validated manifest. Release tooling must:

- completely validate the pack before archiving;
- derive the tag, archive name, version, and release metadata from that one
  manifest;
- use stable archive ordering and normalized archive metadata;
- return a no-op only when an existing release has exactly matching validated
  assets and checksums;
- fail on any mismatched tag or asset without replacing assets or moving a tag.

The mutable `packs` latest pointer is a legacy distribution mechanism and is
not changed by immutable incremental publication. Consumers of an incremental
version pin its explicit release tag.

## Publishing with provenance

`scripts/release-pack.mjs` captures provenance automatically and writes it into
both the manifest (already present in the packaged `pack.db` directory) and the
index. The builder (`scripts/build-cve-pack.mjs`) stamps the corpus commit/date
and embedding model at build time; the release script fills `build.date` and the
version tag:

```bash
# Publish an immutable, dated version and update the `packs` latest pointer
node scripts/release-pack.mjs --pack cve --tag cve-2025.06

# Inspect the artifacts (including the provenance block) without uploading
node scripts/release-pack.mjs --pack cve --tag cve-2025.06 --dry-run --out-dir /tmp/cve-rel
cat /tmp/cve-rel/cve.pack-release.json | jq .provenance
```

| Flag              | Default          | Meaning                                                                                                  |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `--tag`           | `packs`          | Release tag. Use `cve-YYYY.MM` for an immutable version; the script also updates `packs` to point at it. |
| `--corpus-commit` | from build stamp | Override the recorded corpus commit (else taken from the pack manifest / build stamp).                   |
| `--corpus-date`   | from build stamp | Override the recorded corpus date.                                                                       |
| `--model`         | manifest model   | Override the recorded embedding model id.                                                                |

See [docs/cve.md](cve.md#publish-a-pack-as-a-release-artifact) for the full
publishing flow and the remaining `release-pack.mjs` flags, and
[docs/pack-signing.md](pack-signing.md) for signing the published index.

## Related docs

- [docs/pack-signing.md](pack-signing.md) — sign & verify the release index.
- [docs/cve.md](cve.md) — build & publish the CVE pack.
- [docs/packages/packs.md](packages/packs.md) — manifest schema & versioning helpers.
- [Incremental update contract](reference/incremental-update.md) — schema-v2
  identity, lineage, manifest, and complete validation.
