# Pack release versioning & provenance

Published knowledge packs carry one manifest-derived **version**, deterministic
artifact identity, lineage, checksums, and provenance. Publication is immutable:
an existing exact release is a no-op, while any tag or asset mismatch fails.

This document covers the release-tag scheme, the provenance fields written into
`manifest.json` and the `<name>.pack-release.json` index, and how `wikigr pack
pull` selects a version.

## Release-tag convention

Packs are published to GitHub Releases (see [docs/cve.md](cve.md)). A dated tag
identifies one immutable release:

| Tag             | Meaning                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `cve-YYYY.MM`   | Conventional dated release name (for example, `cve-2025.06`).                                        |
| `cve-YYYY.MM.N` | Conventional additional build in the same month (`N` starts at `0`).                                 |
| `packs`         | Optional explicitly published channel; it is never moved as a side effect of publishing another tag. |

For a dated tag, the release script derives the expected SemVer and requires it
to equal the archived manifest version. It never rewrites either value.

> **Tag vs. version — the month is _not_ zero-padded in the version.** The git
> **tag** zero-pads the month for readable, lexically-sortable tags
> (`cve-2025.06`). The derived index **version** omits that pad because SemVer 2.0
> forbids leading zeros in the numeric core. The tag `cve-2025.06` maps to
> `2025.6.0`, and `cve-2025.06.1` maps to `2025.6.1`.

## Pull a specific version

`wikigr pack pull cve` defaults to `packs` for backward compatibility. Immutable
consumers should select a dated tag:

```bash
wikigr pack pull cve                       # latest (the `packs` pointer)
wikigr pack pull cve --tag cve-2025.06      # selected dated release
wikigr pack pull cve --tag cve-2025.06.1    # a specific rebuild
```

After install, verify what you got:

```bash
wikigr pack info cve      # prints the archived manifest version + provenance
```

## Provenance

Build provenance can appear in two places:

1. the pack's `manifest.json` (`provenance` object), and
2. the `<name>.pack-release.json` release index (`provenance` object).

The release script starts with manifest provenance and applies explicit
command-line overrides. Update-capable manifests additionally record `packId`,
`buildId`, `contentDigest`, base lineage, `deltaId`, the raw delta hash, versions,
update counts, graph/provenance counts, and sorted payload checksums.

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
  "version": "1.0.0",
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
    /* copied from the manifest unless release options override fields */
  },
  "parts": [
    { "file": "cve.tar.gz.000", "bytes": 1992294400, "sha256": "…" },
    { "file": "cve.tar.gz.001", "bytes": 1992294400, "sha256": "…" },
    { "file": "cve.tar.gz.002", "bytes": 100274176, "sha256": "…" },
  ],
}
```

> Manifest provenance receives **structural validation** from
> [`@kgpacks/packs`](packages/packs.md): declared string fields must be strings and
> embedding dimensions must be a non-negative number. It does not verify date
> formats, corpus identity, completeness, or correspondence with `pack.db`.
> Dangerous keys (`__proto__`, `constructor`, `prototype`) are stripped when the
> object is rebuilt.

## Publishing with provenance

The builder (`scripts/build-cve-pack.mjs`) writes corpus, embedding, and build
provenance into `manifest.json`. `scripts/release-pack.mjs` reads that block and
writes it into the release index, with any explicit overrides. It does not modify
the archived manifest:

```bash
# Publish one immutable dated release
node scripts/release-pack.mjs --pack cve --tag cve-2025.06

# Inspect the artifacts (including the provenance block) without uploading
node scripts/release-pack.mjs --pack cve --tag cve-2025.06 --dry-run --out-dir /tmp/cve-rel
cat /tmp/cve-rel/cve.pack-release.json | jq .provenance
```

| Flag              | Default             | Meaning                                                                       |
| ----------------- | ------------------- | ----------------------------------------------------------------------------- |
| `--tag`           | `<name>-v<version>` | The immutable manifest-derived release tag. No other tag is moved or updated. |
| `--corpus-commit` | from manifest       | Override the corpus commit in the release index.                              |
| `--corpus-date`   | from manifest       | Override the corpus date in the release index.                                |
| `--model`         | manifest model      | Override the embedding model in the release index.                            |

### Publication guarantees

The default tag is derived from the manifest (for example, `cve-v2025.6.0`). For
an explicit dated tag, the derived version (`cve-2025.06` becomes `2025.6.0`) must
equal the manifest version. Only comprehensively validated schema-v2 packs may be
published. Tar members use stable ordering, epoch timestamps, and numeric owner
metadata. A new release is created as a draft, assets are uploaded without
`--clobber`, and the draft is published only after upload succeeds. If the tag
already exists, every remote asset name, size, and SHA-256 digest must match for a
no-op success; otherwise publication fails without replacing assets or moving the
tag.

See [docs/cve.md](cve.md#publish-a-pack-as-a-release-artifact) for the full
publishing flow and the remaining `release-pack.mjs` flags, and
[docs/pack-signing.md](pack-signing.md) for signing the published index.

## Related docs

- [docs/pack-signing.md](pack-signing.md) — sign & verify the release index.
- [docs/cve.md](cve.md) — build & publish the CVE pack.
- [docs/packages/packs.md](packages/packs.md) — manifest schema & versioning helpers.
