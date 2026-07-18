---
title: How to update a knowledge pack from a CVE delta
description: Apply, resume, validate, and safely publish an incremental CVE knowledge-pack update
last_updated: 2026-07-18
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: howto
---

# How to update a knowledge pack from a CVE delta

Use incremental update with a validated schema-v2 CVE base and a UTF-8 NDJSON
delta. The command creates a new pack; it never changes the base, delta, or an
existing non-equivalent output.

## Prerequisites

- Node.js 22 or newer and the `wikigr` CLI
- Linux with same-filesystem atomic no-replace rename support
- A completely valid schema-v2 CVE base pack
- Free space for a copy of the base plus temporary LadybugDB files

Legacy and prototype packs lack source ownership required for safe deletion.
Rebuild them as schema v2 before updating.

## Apply a delta

```bash
NODE_OPTIONS=--max-old-space-size=32768 \
  wikigr update \
  --base /srv/kgpacks/releases/cve-2026.7.0 \
  --delta /srv/kgpacks/deltas/cve-2026-07-18.ndjson \
  --output /srv/kgpacks/releases/cve-2026.7.1 \
  --version 2026.7.1 \
  --work-dir /srv/kgpacks/work/cve-2026.7.1
```

`wikigr pack update` accepts the same flags. Success writes one JSON object
containing identity, all four update counts, `noop`, and the output path.

The counts classify submitted delta records. Omitted base records remain live
and are not counted. Manifest graph statistics describe the complete result.

## Prepare the delta

A raw CVE 5 NDJSON line is an upsert:

```json
{
  "dataType": "CVE_RECORD",
  "dataVersion": "5.1",
  "cveMetadata": { "cveId": "CVE-2026-12345", "state": "PUBLISHED" },
  "containers": {
    "cna": {
      "descriptions": [
        { "lang": "en", "value": "An input validation vulnerability in the request parser." }
      ]
    }
  }
}
```

Use an envelope for deletion:

```json
{ "operation": "delete", "key": "CVE-2025-31415" }
```

The entire delta is rejected before work is created if it contains a duplicate
identity, malformed record, delete for an absent identity, or `REJECTED` record.
Canonical equality is `unchanged`; object-key order and whitespace do not make a
record `modified`.

## Resume an interrupted update

```bash
NODE_OPTIONS=--max-old-space-size=32768 \
  wikigr update --resume /srv/kgpacks/work/cve-2026.7.1
```

Do not repeat fresh-mode flags. Resume verifies saved identity, exact input
bytes, staged LadybugDB state, durable applications, target version, paths, and
component versions. A mismatch returns `RESUME_MISMATCH` without changing
inputs, output, or incompatible work.

## Validate the result

```bash
wikigr --packs-dir /srv/kgpacks/releases pack validate cve-2026.7.1
```

```ts
import { validateKnowledgePack } from '@kgpacks/packs';

const result = await validateKnowledgePack('/srv/kgpacks/releases/cve-2026.7.1');
console.log(result.schemaVersion, result.manifest.buildId);
```

Complete validation independently recomputes identity, provenance,
classifications, counts, whole-pack statistics, indexes, hashes, and
`contentDigest` from durable LadybugDB state and filesystem bytes.

## Handle an existing destination

Re-running the same update against a byte-identical output succeeds with
`"noop": true`. Any other existing file, directory, symlink, or pack produces
`OUTPUT_COLLISION` and remains untouched. Choose another version or output path;
do not automatically delete a collision.

## Handle failures

Expected failures write one JSON object to stderr and exit `7`:

```json
{
  "error": {
    "type": "KnowledgePackUpdateError",
    "code": "INVALID_DELTA",
    "message": "delete target does not exist: CVE-2025-31415"
  }
}
```

Use `error.code`, not message text, in automation.

| Code                      | Action                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `INVALID_DELTA`           | Correct the complete delta and start fresh.                 |
| `INELIGIBLE_BASE`         | Rebuild or replace the base with a valid schema-v2 pack.    |
| `VERSION_CONFLICT`        | Choose valid SemVer different from the base version.        |
| `PATH_CONFLICT`           | Use disjoint base, output, and work paths.                  |
| `WORK_DIR_CONFLICT`       | Use absent work for fresh mode or explicitly resume it.     |
| `RESUME_MISMATCH`         | Preserve work for diagnosis; restart in a new workspace.    |
| `OUTPUT_COLLISION`        | Preserve the destination; use another version or path.      |
| `PUBLICATION_UNSUPPORTED` | Use a filesystem with atomic no-replace rename support.     |
| `PUBLICATION_FAILED`      | Preserve resumable work and inspect the durability failure. |

## Related documentation

- [Incremental CVE update tutorial](../tutorials/incremental-cve-update.md)
- [Incremental update reference](../reference/incremental-update.md)
- [Pack versioning and provenance](../pack-versioning.md)
- [Resumable full builds](../resumable-build.md)
