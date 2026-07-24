# Pack release versioning & provenance

Published knowledge packs are **versioned** and carry **provenance** — a record of
exactly which corpus, embedding model, and build produced them. This lets you pin
a reproducible pack, audit where a pack came from, and roll forward or back without
ambiguity.

This document covers the release-tag scheme, the provenance fields written into
`manifest.json` and the `<name>.pack-release.json` index, and how `wikigr pack
pull` selects a version.

## Release tags

Packs are published to immutable GitHub Releases (see
[docs/cve.md](cve.md)). The default tag is derived from the validated manifest:
`<name>-v<version>`. A dated alias is accepted only when it maps to the same
manifest version.

| Tag             | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `cve-v<semver>` | The default immutable tag derived exactly from `manifest.version`.                 |
| `cve-YYYY.MM`   | An immutable dated alias for version `YYYY.M.0` (for example, `cve-2025.06`).      |
| `cve-YYYY.MM.N` | An immutable dated alias for version `YYYY.M.N`.                                   |
| `packs`         | A legacy mutable release that can still be selected explicitly with `--tag packs`. |

Pack **manifest** `version` fields use a **SemVer 2.0** string derived from the
tag, so `wikigr pack info cve` and the registry's version comparison (see
[`@kgpacks/packs` versioning](packages/packs.md)) order releases correctly.

The schema-v2 incremental API requires strict SemVer 2.0, including valid
prerelease and build metadata. A target version must differ from its base
version.

> **Tag vs. version — the month is _not_ zero-padded in the version.** The git
> **tag** zero-pads the month for readable, lexically-sortable tags
> (`cve-2025.06`). The manifest **version** must omit that pad — SemVer 2.0 forbids
> leading zeros in the numeric core, so `2025.06.0` is **invalid** and is rejected
> by `@kgpacks/packs`'s validator. The tag `cve-2025.06` therefore maps to version
> `2025.6.0`, and `cve-2025.06.1` to `2025.6.1`. Numeric comparison still orders
> months correctly (`2025.6.0` < `2025.11.0`).

## Pull a version

Without `--tag`, `wikigr pack pull cve` discovers immutable releases for the
requested pack. Before ranking, it excludes drafts, releases GitHub marks as
prereleases, unsupported or SemVer-prerelease versions, non-ASCII tags, and
releases missing the required index or signature assets. It ranks the remaining
candidates by SemVer precedence, publication time, the original raw tag using
ordinal ASCII-byte order, and numeric GitHub release ID. The tag tie-break is
locale-independent and does not compare a normalized version. Pass `--tag` to
pin a release and bypass automatic filtering and ranking:

```bash
wikigr pack pull cve                        # latest discoverable immutable release
wikigr pack pull cve --tag cve-v2025.6.0    # manifest-derived immutable tag
wikigr pack pull cve --tag cve-2025.06      # pinned, immutable version
wikigr pack pull cve --tag cve-2025.06.1    # a specific rebuild
wikigr pack pull cve --tag packs            # explicit legacy mutable release
```

See the
[pack release discovery reference](reference/pack-release-discovery.md#automatic-discovery)
for the complete candidate and transport contract.

After install, verify what you got:

```bash
wikigr pack info cve      # prints version + full provenance block
```

## Provenance

Every published pack records **how it was built** in two places. By default the
release index mirrors the manifest block so they can be cross-checked:

1. the pack's `manifest.json` (`provenance` object), and
2. the `<name>.pack-release.json` release index (`provenance` object).

### Fields

| Field                  | Example                     | Meaning                                                            |
| ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| `corpus.name`          | `"cvelistV5"`               | Source corpus identifier.                                          |
| `corpus.commit`        | `"a1b2c3d4…"`               | The exact upstream commit SHA the records were built from.         |
| `corpus.date`          | `"2025-06-14"`              | Publish/snapshot date of that corpus revision (UTC, `YYYY-MM-DD`). |
| `corpus.tag`           | `"cve_2025-06-14_0000Z"`    | Human-readable upstream release tag, preserved separately.         |
| `embedding.model`      | `"Xenova/bge-base-en-v1.5"` | The BGE model id used to embed every record (deterministic).       |
| `embedding.dimensions` | `768`                       | Embedding vector length.                                           |
| `build.date`           | `"2025-06-15T04:22:10Z"`    | When the pack was built (UTC, ISO-8601).                           |
| `build.tool_version`   | `"agent-kgpacks-ts@0.0.0"`  | The builder version that produced the pack.                        |

Legacy builders may use `"unknown"` for unavailable values. Schema-v2 CVE packs
require a full lowercase 40-character Git SHA-1 and a real UTC calendar date;
tags, branches, abbreviations, malformed dates, and `"unknown"` are rejected.
Wall-clock build dates remain omitted from deterministic outputs.

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
> ([`@kgpacks/packs`](packages/packs.md)): declared text fields are strings or
> null, and `embedding.dimensions` is a non-negative finite number. Dangerous
> keys
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

Incremental pack publication uses an immutable release tag derived from the
validated manifest. Release tooling:

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

`scripts/build-cve-pack.mjs` stamps the exact corpus commit and date into the
database and manifest. Incremental updates preserve those values without
normalization. The release script mirrors the same values into the release
index.

The release generator treats an absent `schemaVersion` and `"1"` as legacy,
runs complete pack validation for `"2"`, and rejects every other schema version.
It never treats an unknown version as legacy.

### Legacy fill behavior

For a legacy manifest, release flags fill only missing release-index provenance
fields. Existing manifest values are authoritative and are never replaced:

- each existing `provenance.corpus.commit`, `.date`, and `.tag` value wins over
  its corresponding `--corpus-*` flag;
- the embedding model is selected from existing manifest data in this order:
  `provenance.embedding.model`, `model`, then `synthesis_model`;
- `--model` is used only when none of those manifest fields supplies an
  embedding model.

This permits a partially populated legacy manifest to fill one missing field
without changing the others. For example, given a legacy manifest that already
declares a corpus commit and embedding model but omits its corpus date and tag,
the command below fills only the missing values:

```bash
node scripts/release-pack.mjs \
  --pack cve \
  --corpus-date 2025-06-14 \
  --corpus-tag cve_2025-06-14_0000Z \
  --dry-run \
  --out-dir /tmp/cve-rel
```

### Schema-v2 assertion behavior

For a schema-v2 manifest, provenance flags are optional exact-match assertions,
not overrides or defaults. A supplied `--corpus-commit`, `--corpus-date`,
`--corpus-tag`, or `--model` must equal the corresponding manifest provenance
string exactly under the normal case-sensitive comparison. Complete schema-v2
pack validation runs before these assertions are evaluated, so an invalid pack
cannot be masked by either matching or mismatching flags. An assertion mismatch
stops generation before release parts are created. Omitting the flags leaves
the validated manifest values unchanged.

```bash
# Succeeds only when every supplied value exactly matches manifest.json.
node scripts/release-pack.mjs \
  --pack cve \
  --corpus-commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 \
  --corpus-date 2025-06-14 \
  --corpus-tag cve_2025-06-14_0000Z \
  --model Xenova/bge-base-en-v1.5 \
  --dry-run \
  --out-dir /tmp/cve-rel
```

Common publishing commands:

```bash
# Publish using the default manifest-derived tag
node scripts/release-pack.mjs --pack cve

# Publish an equivalent immutable dated tag
node scripts/release-pack.mjs --pack cve --tag cve-2025.06

# Inspect the artifacts (including the provenance block) without uploading
node scripts/release-pack.mjs --pack cve --tag cve-2025.06 --dry-run --out-dir /tmp/cve-rel
cat /tmp/cve-rel/cve.pack-release.json | jq .provenance
```

| Flag              | Default                      | Meaning                                                                                                        |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--tag`           | `<name>-v<manifest.version>` | Immutable release tag; dated tags must imply the exact manifest version.                                       |
| `--corpus-commit` | manifest provenance          | Schema-v2 exact-match assertion; otherwise fills only a missing legacy corpus commit.                          |
| `--corpus-date`   | manifest provenance          | Schema-v2 exact-match assertion; otherwise fills only a missing legacy corpus date.                            |
| `--corpus-tag`    | manifest provenance          | Schema-v2 exact-match assertion; otherwise fills only a missing legacy source release tag.                     |
| `--model`         | manifest model               | Schema-v2 exact-match assertion; otherwise fills a legacy embedding model only when the manifest has no model. |

See [docs/cve.md](cve.md#publish-a-pack-as-a-release-artifact) for the full
publishing flow and the remaining `release-pack.mjs` flags, and
[docs/pack-signing.md](pack-signing.md) for signing the published index.

## Related docs

- [docs/pack-signing.md](pack-signing.md) — sign & verify the release index.
- [docs/cve.md](cve.md) — build & publish the CVE pack.
- [docs/packages/packs.md](packages/packs.md) — manifest schema & versioning helpers.
- [Incremental update contract](reference/incremental-update.md) — schema-v2
  identity, lineage, manifest, and complete validation.
