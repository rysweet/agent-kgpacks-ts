---
title: Incremental knowledge-pack update reference
description: CLI, API, configuration, delta, validation, resume, and publication reference for schema-v2 pack updates
last_updated: 2026-07-18
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: reference
---

# Incremental knowledge-pack update reference

Incremental update applies a CVE delta to an immutable schema-v2 base pack and
publishes a separately versioned output. The updater validates persisted
LadybugDB state, supports interruption-safe resume, and never replaces an
existing destination.

For a guided first update, follow the
[incremental CVE update tutorial](../tutorials/incremental-cve-update.md). For
production procedures, see [how to update a knowledge pack](../howto/update-knowledge-pack.md).

## Contents

- [CLI](#cli)
- [Configuration](#configuration)
- [TypeScript API](#typescript-api)
- [Delta format](#delta-format)
- [Classification and identity](#classification-and-identity)
- [Manifest](#manifest)
- [Durable validation](#durable-validation)
- [Mutation and cleanup](#mutation-and-cleanup)
- [Resume](#resume)
- [Publication](#publication)
- [Errors and exit codes](#errors-and-exit-codes)

## CLI

Fresh mode:

```bash
wikigr update \
  --base <pack-dir> \
  --delta <file.ndjson> \
  --output <pack-dir> \
  --version <semver> \
  [--work-dir <dir>]
```

Resume mode:

```bash
wikigr update --resume <work-dir>
```

`wikigr pack update` is an exact alias. Fresh mode requires `--base`,
`--delta`, `--output`, and `--version`. Resume accepts only `--resume`. These
forms cannot be mixed with each other or with seed-update options.

The existing seed-update form remains available:

```bash
wikigr update --pack <name> (--seeds <url...> | --config <file>) [options]
```

Successful incremental calls write exactly one JSON object to stdout:

```json
{
  "packId": "cve",
  "version": "2026.7.1",
  "buildId": "64b9970cf52afc7c966a8ca9c68cffd310a9c82012c59ff684863f75956315d6",
  "deltaId": "2d25c8cc2a457f928327ea934819e69dca78e4a1f17ed405d9ca10b996ec499b",
  "added": 148,
  "modified": 31,
  "deleted": 2,
  "unchanged": 7,
  "noop": false,
  "output": "/srv/kgpacks/releases/cve-2026.7.1"
}
```

Domain failures leave stdout empty and write exactly one JSON error object to
stderr.

## Configuration

Incremental update has no feature-specific config file or environment variable.

| Setting   | CLI                     | API field | Default         |
| --------- | ----------------------- | --------- | --------------- |
| Base pack | `--base <pack-dir>`     | `base`    | required        |
| CVE delta | `--delta <file.ndjson>` | `delta`   | required        |
| Output    | `--output <pack-dir>`   | `output`  | required        |
| Version   | `--version <semver>`    | `version` | required        |
| Workspace | `--work-dir <dir>`      | `workDir` | `<output>.work` |
| Resume    | `--resume <work-dir>`   | `workDir` | separate mode   |

The target version must be SemVer 2.0, must match
`^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$`, and must differ from the base version.
The safe path constraint excludes SemVer build metadata containing `+`.

Base, output, and work paths are canonicalized without following a symlink into
the trust boundary. They must be pairwise disjoint. Output and work must be on
the same filesystem.

`NODE_OPTIONS` can size the heap for large packs:

```bash
NODE_OPTIONS=--max-old-space-size=32768 wikigr update --resume /srv/kgpacks/work/cve-2026.7.1
```

Heap settings do not participate in identity, resume state, or output bytes.

## TypeScript API

`@kgpacks/packs` owns update orchestration, complete validation, resume, and
publication.

```ts
interface FreshUpdateKnowledgePackRequest {
  mode: 'fresh';
  base: string;
  delta: string;
  output: string;
  version: string;
  workDir?: string;
}

interface ResumeUpdateKnowledgePackRequest {
  mode: 'resume';
  workDir: string;
}

type UpdateKnowledgePackRequest =
  | FreshUpdateKnowledgePackRequest
  | ResumeUpdateKnowledgePackRequest;

interface UpdateKnowledgePackResult {
  packId: string;
  version: string;
  buildId: string;
  deltaId: string;
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  noop: boolean;
  output: string;
}

interface LegacyKnowledgePackValidationResult {
  valid: true;
  schemaVersion: 1;
  manifest: PackManifestV1;
}

interface V2KnowledgePackValidationResult {
  valid: true;
  schemaVersion: 2;
  manifest: PackManifestV2;
  counts: PackGraphStatsV2;
}

declare function updateKnowledgePack(
  request: FreshUpdateKnowledgePackRequest | ResumeUpdateKnowledgePackRequest,
): Promise<UpdateKnowledgePackResult>;

declare function validateKnowledgePack(
  packDir: string,
): Promise<LegacyKnowledgePackValidationResult | V2KnowledgePackValidationResult>;
```

Requests are closed and discriminated. Unknown fields, mixed modes, aliases,
unsafe numbers, and invalid paths are rejected. Failures throw and never return
a partial result.

IDs are lowercase SHA-256 hex. Counts are safe non-negative integers. `output`
is canonical and absolute. `noop` is true only when an existing destination is
byte-identical to validated staging.

```ts
import { updateKnowledgePack, validateKnowledgePack } from '@kgpacks/packs';

const update = await updateKnowledgePack({
  mode: 'fresh',
  base: '/srv/kgpacks/releases/cve-2026.7.0',
  delta: '/srv/kgpacks/deltas/cve-2026-07-18.ndjson',
  output: '/srv/kgpacks/releases/cve-2026.7.1',
  version: '2026.7.1',
  workDir: '/srv/kgpacks/work/cve-2026.7.1',
});

const validation = await validateKnowledgePack(update.output);
console.log(validation.schemaVersion, update.buildId);
```

## Delta format

The delta is strict UTF-8 NDJSON. Empty lines are ignored. Every other line is
one complete object. Preflight validates the entire file before creating work
or mutating durable state.

A raw CVE 5 record is an upsert:

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

An upsert envelope has exactly `operation`, `key`, and `payload`; `key` must
equal `payload.cveMetadata.cveId`:

```json
{
  "operation": "upsert",
  "key": "CVE-2026-12345",
  "payload": {
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
}
```

A delete envelope has exactly `operation` and `key`:

```json
{ "operation": "delete", "key": "CVE-2025-31415" }
```

Deleting an absent identity is invalid. A delete cannot include a payload.
`REJECTED` records are invalid and are never interpreted as deletes.

Preflight rejects invalid UTF-8, malformed JSON, unknown fields or operations,
duplicate identities, key/payload mismatches, malformed CVEs, and nonexistent
deletions. There is no first-wins, last-wins, skip, or partial-apply behavior.

Canonical payload serialization recursively sorts object keys, preserves array
order, uses ECMAScript `JSON.stringify` semantics without insignificant
whitespace, and encodes UTF-8. Strings are not Unicode-normalized. The exact
delta-file SHA-256 is retained separately as transport provenance.

## Classification and identity

| Operation | Base state | Canonical payload | Classification |
| --------- | ---------- | ----------------- | -------------- |
| `upsert`  | absent     | n/a               | `added`        |
| `upsert`  | present    | unequal           | `modified`     |
| `upsert`  | present    | equal             | `unchanged`    |
| `delete`  | present    | n/a               | `deleted`      |
| `delete`  | absent     | n/a               | invalid delta  |

Omitted base records remain live and are not counted. An empty delta is valid
and has four zero counts.

`deltaId` hashes key-sorted semantic operations. Record order, object-key order,
and transport whitespace do not change it. `buildId` hashes canonical JSON
containing the pack ID, target version, schema/adapter/extractor/tool versions,
base content digest, and `deltaId`. Wall-clock values never participate.

## Manifest

Schema v2 is strict and closed. Incremental manifests contain:

```ts
type UpdateClassification = 'added' | 'modified' | 'deleted' | 'unchanged';

interface PackUpdateV2 {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  records: PackUpdateRecordV2[];
}

interface PackManifestV2 {
  name: string;
  packId: string;
  version: string;
  schemaVersion: '2';
  adapterVersion: string;
  extractorVersion: string;
  toolVersion: string;
  buildId: string;
  provenance: PackProvenanceV2;
  lineage: PackLineageV2;
  update: PackUpdateV2;
  graph_stats: PackGraphStatsV2;
  files: PackFileMetadataV2[];
  contentDigest: string;
}
```

`update.records` is key-sorted and covers every current delta key once. Counts
equal its classifications. `graph_stats` describes the complete result, not the
delta. Baselines have null lineage and an empty zero-count update; incremental
outputs have non-null base/delta lineage even for an empty delta.

`files` is path-sorted and excludes `manifest.json`; `contentDigest` hashes the
canonical complete file list. Schema-v2 packs contain only `pack.db` and
`manifest.json`. Release tooling never mutates a schema-v2 pack manifest.

## Durable validation

LadybugDB is authoritative for pack/build/component identity, lineage,
provenance, source payloads, update applications, support ownership, and final
graph state. Filesystem bytes are authoritative for closure, sizes, hashes, and
`contentDigest`.

`validateManifest` is a synchronous structural gate.
`validateKnowledgePack` and `wikigr pack validate` additionally:

1. open `pack.db` read-only;
2. verify required schema, relationships, and indexes;
3. recompute source hashes, classifications, all four counts, `deltaId`,
   `buildId`, lineage, and provenance;
4. reproduce live derived graph state through recorded components;
5. prove exact support, uniqueness, and no-orphan cardinalities;
6. prove live search/vector membership and absence of stale rows;
7. recompute whole-pack statistics; and
8. verify every payload hash, byte count, and `contentDigest`.

Every manifest field is checked independently against durable authority.
Changing related fields together cannot make tampering pass.

Legacy v1 packs remain readable but cannot be incremental bases. Prototype and
incomplete packs fail with rebuild guidance; ownership is never inferred from
graph shape.

## Mutation and cleanup

The updater copies the base and mutates staging only. Key-sorted operations use
bounded transactions and become resumable only after a durable checkpoint.

Modified and deleted records remove obsolete article, section, chunk, link,
support, graph, lexical/search, and vector-index state. Unsupported entities
and relationships are removed; shared facts survive while another live article
supports them. Modified records then materialize their replacement. Unchanged
records do not rewrite graph state but receive a durable application row.

## Resume

```text
<work-dir>/
├── update-state.json
└── staging/
    ├── manifest.json
    └── pack.db
```

Fresh mode requires the work path to be absent. The state file records canonical
paths, version, IDs, component versions, exact base/delta digests, phase, and
classified operations. LadybugDB application rows, not sidecar flags, are
authoritative for completed work.

Resume verifies identity, inputs, staging, paths, versions, and durable state.
It skips completed work and rejects incompatible state with `RESUME_MISMATCH`.
Resumed and uninterrupted execution produce the same logical state and bytes.

## Publication

The updater preflights inputs, snapshots immutable bytes, copies the base to
same-filesystem staging, applies and checkpoints the delta, rebuilds indexes,
reopens and validates staging, fsyncs files/directories, rechecks inputs and the
destination, and promotes with `renameat2(RENAME_NOREPLACE)`.

Node `rename()` plus an existence check is not used. Unsupported no-replace
publication fails before work starts. A byte-identical existing destination can
complete without the primitive because no rename occurs.

| Destination                                   | Result             |
| --------------------------------------------- | ------------------ |
| Valid and byte-identical to validated staging | `noop: true`       |
| Valid but different                           | `OUTPUT_COLLISION` |
| Invalid/empty directory, file, or symlink     | `OUTPUT_COLLISION` |
| Appears during publication                    | Same comparison    |

Equivalence compares every entry and byte; matching manifest claims are not
enough. Base and delta bytes remain unchanged on every success, no-op, failure,
interruption, resume, and collision path.

## Errors and exit codes

```ts
type KnowledgePackUpdateErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_DELTA'
  | 'INELIGIBLE_BASE'
  | 'VERSION_CONFLICT'
  | 'PATH_CONFLICT'
  | 'WORK_DIR_CONFLICT'
  | 'RESUME_MISMATCH'
  | 'OUTPUT_COLLISION'
  | 'PUBLICATION_UNSUPPORTED'
  | 'PUBLICATION_FAILED';
```

```json
{
  "error": {
    "type": "KnowledgePackUpdateError",
    "code": "INVALID_DELTA",
    "message": "delete target does not exist: CVE-2025-31415"
  }
}
```

Validation failures include a non-empty `diagnostics` array. Callers branch on
`type` and `code`, not message text.

| Outcome                                     | Exit |
| ------------------------------------------- | ---: |
| Incremental success or byte-identical no-op |  `0` |
| Commander usage failure                     |  `2` |
| Standalone `pack validate` failure          |  `4` |
| Expected incremental update failure         |  `7` |
| Unexpected internal failure                 |  `1` |

## Related documentation

- [Incremental CVE update tutorial](../tutorials/incremental-cve-update.md)
- [How to update a knowledge pack](../howto/update-knowledge-pack.md)
- [CVE knowledge pack](../cve.md)
- [Resumable full builds](../resumable-build.md)
- [Pack versioning and provenance](../pack-versioning.md)
- [`@kgpacks/packs` reference](../packages/packs.md)
