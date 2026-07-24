---
title: Incremental knowledge-pack update contract
description: Reference for the schema-v2 CVE update API, delta grammar, durable metadata, validation, and publication guarantees
last_updated: 2026-07-24
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: reference
---

# Incremental knowledge-pack update contract

This reference defines the implemented schema-v2 APIs and CLI semantics.

## Contents

- [CLI contract](#cli-contract)
- [Public TypeScript API](#public-typescript-api)
- [Canonical corpus provenance](#canonical-corpus-provenance)
- [Delta grammar](#delta-grammar)
- [Classification and identity](#classification-and-identity)
- [Base eligibility](#base-eligibility)
- [Version compatibility](#version-compatibility)
- [Durable authority](#durable-authority)
- [Schema-v2 manifest](#schema-v2-manifest)
- [Validation boundaries](#validation-boundaries)
- [Resume and publication](#resume-and-publication)
- [Errors and exit codes](#errors-and-exit-codes)

## CLI contract

Fresh mode:

```text
wikigr update \
  --base <pack-dir> \
  --delta <file> \
  --output <pack-dir> \
  --version <version> \
  [--work-dir <dir>]
```

Resume mode:

```text
wikigr update --resume <work-dir>
```

`wikigr pack update` is an exact alias. Fresh mode requires all four required
options. Resume mode accepts only `--resume`; the fresh and resume option sets
are mutually exclusive. The target version must be strict SemVer 2.0, including
the standard prerelease and build-metadata grammar, and must differ from the
base version. The difference is exact string inequality after validation.

The canonicalized base, output, and work paths must be pairwise disjoint: no
path may equal, contain, or be contained by another. Symlinks and non-directory
ancestors are rejected rather than followed into the trust boundary. Work and
output must be on the same filesystem. If `--work-dir` is omitted, fresh mode
uses `<output>.work`.

Commander validates mode shape before calling the package API. `--resume`
cannot be combined with `--base`, `--delta`, `--output`, `--version`, or
`--work-dir`; without `--resume`, all four required fresh flags must be present.
Global options such as `--packs-dir` do not become request fields.

## Public TypeScript API

`@kgpacks/ingestion` exports the lifecycle entry points, configuration/result
types, durable metadata types, and typed failures. `@kgpacks/packs` exports the
schema-v2 manifest types and structural manifest validator.

```ts
interface FreshUpdateConfig {
  base: string;
  delta: string;
  output: string;
  version: string;
  workDir?: string;
  embedder?: Embedder;
  onCheckpoint?: (checkpoint: PackCheckpoint) => void;
}

interface ResumeUpdateConfig {
  resume: string;
  embedder?: Embedder;
  onCheckpoint?: (checkpoint: PackCheckpoint) => void;
}

type UpdateKnowledgePackConfig = FreshUpdateConfig | ResumeUpdateConfig;

interface UpdateKnowledgePackResult {
  packId: string;
  version: string;
  buildId: string;
  deltaId: string;
  added: number;
  modified: number;
  unchanged: number;
  noop: boolean;
  output: string;
}

interface PackValidationResult {
  valid: true;
  manifest: PackManifest;
  metadata: DurablePackMetadata;
  applications: DurableUpdateApplication[];
  contentDigest: string;
  counts: {
    articles: number;
    sections: number;
    chunks: number;
    entities: number;
    relationships: number;
    entitySupport: number;
    relationSupport: number;
  };
}

declare function updateKnowledgePack(
  config: UpdateKnowledgePackConfig,
): Promise<UpdateKnowledgePackResult>;

declare function validateKnowledgePack(packDir: string): Promise<PackValidationResult>;
```

`UpdateKnowledgePackResult` has exactly the nine fields shown above. Successful
fresh, resume, and matching-destination no-op calls all return that shape.
Failures throw and never return a partial or success-shaped result.
`buildId` and `deltaId` are lowercase SHA-256 hex, all three counts are safe
non-negative integers, and `output` is the canonical absolute output path.
`noop` is false for every newly promoted output, including an empty or
all-unchanged delta; it is true only when an equivalent destination already
exists.

The CLI maps fresh flags to `{ base, delta, output, version, workDir? }` and
`--resume <work-dir>` to `{ resume: workDir }`. It
serializes the returned object once as the only stdout document.

The CLI `BuildProgramOptions` has a separate injectable seam:

```ts
updateKnowledgePack?: (
  config: UpdateKnowledgePackConfig,
) => Promise<UpdateKnowledgePackResult>;
```

`buildPack` remains the seed-based full ingestion seam for `create`; it does not
implement incremental updates.

`@kgpacks/ingestion` also exports `PackCheckpoint`, `DurablePackMetadata`,
`DurableUpdateApplication`, `KnowledgePackUpdateError`, and
`KnowledgePackValidationError`. It owns update orchestration, the versioned CVE
adapter, manifest projection, complete validation, resume, and publication. It
uses `@kgpacks/db` for LadybugDB and `@kgpacks/packs` for manifest
serialization. The CLI loads this update seam lazily.

The package also exports the provenance-capable CVE full-build entry point and
resolver:

```ts
interface BuildCvePackConfig {
  source: string;
  output: string;
  packId: string;
  version: string;
  embedder: Embedder;
  corpusCommit?: string;
  corpusDate?: string;
  corpusTag?: string | null;
}

interface CorpusProvenanceIdentity {
  commit: string;
  date: string;
  tag: string | null;
}

declare function resolveCorpusProvenance(
  source: string,
  supplied: {
    corpusCommit?: string;
    corpusDate?: string;
    corpusTag?: string | null;
  },
): CorpusProvenanceIdentity;

declare function buildCvePack(config: BuildCvePackConfig): Promise<void>;
```

The optional TypeScript fields do not make partial provenance valid. They may be
omitted only when an authoritative fetched-corpus sidecar supplies the complete
identity.

## Canonical corpus provenance

Every provenance-capable CVE pack has one canonical corpus identity:

```ts
{
  commit: string; // full lowercase 40-character Git SHA-1
  date: string; // real UTC date, YYYY-MM-DD
  tag: string | null;
}
```

`resolveCorpusProvenance()` searches from the source path upward for
`corpus-provenance.json`. When found, the sidecar is authoritative and must have
the exact complete schema documented in
[Fetching the CVE corpus](../cve-corpus.md#provenance). Supplied values are
optional exact-match assertions. A malformed sidecar or any conflicting value
fails; callers cannot replace or complete sidecar data.

Without a sidecar, all three supplied fields are required. `commit` and `date`
must satisfy the formats above. `tag` must be a non-empty string when present;
programmatic callers use explicit `null` to represent a source with no upstream
tag. Missing, partial, malformed, or mismatched values fail before output is
created.

The closure applies at every lifecycle boundary:

- `buildCvePack()` resolves provenance before creating output;
- the comprehensive CVE builder resolves it before fresh staging, requires
  canonical source payload provenance on every streamed article, and re-resolves
  it before resume;
- fresh incremental update accepts provenance only from a completely validated
  base and copies it unchanged;
- incremental resume compares canonical base provenance, staged durable
  provenance, and the saved provenance digest before continuing; and
- complete validation compares the manifest projection with durable
  `PackMetadata` and rejects non-canonical provenance.

No builder summary, checkpoint, update sidecar, command-line override, or
manifest projection can substitute for the authoritative sidecar or durable
database identity.

## Delta grammar

The delta is strict UTF-8 NDJSON. A fatal UTF-8 decoding error rejects the
file. Empty and whitespace-only lines are ignored. Every other line must be one
complete JSON object in one of these forms.

### Raw record

```json
{
  "dataType": "CVE_RECORD",
  "dataVersion": "5.1",
  "cveMetadata": {
    "cveId": "CVE-2026-12345",
    "state": "PUBLISHED"
  },
  "containers": {
    "cna": {
      "descriptions": [
        {
          "lang": "en",
          "value": "An input validation vulnerability."
        }
      ]
    }
  }
}
```

The stable key is `cveMetadata.cveId`.

### Upsert envelope

```json
{
  "operation": "upsert",
  "key": "CVE-2026-12345",
  "payload": {
    "dataType": "CVE_RECORD",
    "dataVersion": "5.1",
    "cveMetadata": {
      "cveId": "CVE-2026-12345",
      "state": "PUBLISHED"
    },
    "containers": {
      "cna": {
        "descriptions": [
          {
            "lang": "en",
            "value": "An input validation vulnerability."
          }
        ]
      }
    }
  }
}
```

An upsert envelope has exactly the three top-level fields shown. `key` is
required and must exactly equal `payload.cveMetadata.cveId`. The record must map
successfully through the versioned CVE adapter.

Explicit delete operations are not supported. Unknown operations, malformed or
unmappable records, duplicate stable keys, mismatched envelope keys, delete
operations, and raw or enveloped CVEs with `cveMetadata.state: "REJECTED"`
reject the complete file.

The updater performs this preflight before it creates or changes work. There is
no first-wins, last-wins, per-record skip, or partial application behavior.

### Canonical payload bytes

After the adapter accepts a record, it emits canonical payload bytes:

1. recursively sort every object key by Unicode code point;
2. preserve array order;
3. serialize the reordered value with ECMAScript `JSON.stringify` semantics and
   no insignificant whitespace;
4. encode the resulting string as UTF-8.

The same canonical JSON routine is used for payload, `deltaId`, `buildId`, and
`contentDigest` inputs. Sorting compares Unicode scalar values, not locale or
host collation. Strings are not Unicode-normalized, and array order remains
semantic. Inputs containing unpaired UTF-16 surrogate escapes are rejected, so
every compared string has a defined scalar-value ordering. This removes
implementation-dependent choices about key ordering, number rendering,
escaping, and whitespace.

Source equality and `sourcePayloadSha256` use these adapter-emitted bytes, not
the original line bytes. Therefore object-key order and transport whitespace do
not create false modifications. `lineage.delta.fileSha256` separately preserves
the SHA-256 of the exact NDJSON file bytes.

## Classification and identity

Records are processed once in stable-key order.

| Operation | Base state  | Canonical payload comparison | Result      |
| --------- | ----------- | ---------------------------- | ----------- |
| `upsert`  | Key absent  | Not applicable               | `added`     |
| `upsert`  | Key present | Different bytes              | `modified`  |
| `upsert`  | Key present | Identical bytes              | `unchanged` |

Omitted base records remain present and are not included in any delta count.
An empty delta is valid and has all three counts equal to zero.

`deltaId` is SHA-256 over canonical JSON for key-sorted entries:

```json
[
  {
    "key": "CVE-2026-12345",
    "operation": "upsert",
    "sourcePayloadSha256": "5036d889676e32a53a47d46a12653a6d37af21db9378f785b79190f9f784de26"
  }
]
```

The semantic array is sorted by key. Upserts include the canonical record hash;
Record order, object-key order, and transport formatting therefore do not affect
`deltaId`. The SHA-256 of the exact input
file bytes is calculated independently and retained as transport provenance.

For an incremental output, `buildId` is SHA-256 over canonical JSON with
exactly these fields:

```json
{
  "adapterVersion": "cve-adapter@2",
  "baseContentDigest": "71d3afc5a14210a66fa538af86f5a03db760f62d64b1bbf5a9f6f9f01fc01d8d",
  "deltaId": "f10f0bf4a4b7c1014544cb9a386f887812b10f1712ba8f475f64608a411c9ec6",
  "embeddingModel": "Xenova/bge-base-en-v1.5",
  "extractorVersion": "cve-adapter@2",
  "packId": "cve",
  "schemaVersion": "2",
  "toolVersion": "agent-kgpacks-ts@0.1.0",
  "version": "2026.7.0"
}
```

Every identity-affecting version is included even when adapter and extractor
currently have the same value.

## Base eligibility

An update base must be a completed, comprehensively valid schema-v2 pack. Its
LadybugDB schema must contain:

- a singleton `PackMetadata` record with pack/build identity and lineage;
- one `ArticleSource` record per article, containing canonical payload bytes,
  SHA-256, and extractor version;
- article-to-entity support represented by exact `HAS_ENTITY` edges;
- one canonical `RelationSupport` record per article-supported relation;
- `UpdateApplication` evidence when the pack itself was incrementally built;
- all required graph columns, primary keys, relationship tables, structured
  lexical columns, and vector indexes.

The required LadybugDB surface is:

| Kind         | Name                        | Required fields or definition                                                                                                      |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Node         | `Article`                   | `title` primary key, `category`, `word_count`, `expansion_depth`                                                                   |
| Node         | `Section`                   | `id` primary key, title/content/embedding/level/word count, plus `cve_id`, affected products, aliases, CPEs, PURLs, and ecosystems |
| Node         | `Chunk`                     | `id` primary key, content/embedding, article title, section index, chunk index                                                     |
| Node         | `Entity`                    | `entity_id` primary key, name, type, description                                                                                   |
| Node         | `PackMetadata`              | singleton key, all identity, provenance, lineage, delta, and version fields listed under [Durable authority](#durable-authority)   |
| Node         | `ArticleSource`             | article key, canonical payload, payload SHA-256, extractor version                                                                 |
| Node         | `RelationSupport`           | support ID/signature, article key, source/target entity IDs, relation, context, extractor version                                  |
| Node         | `UpdateApplication`         | article key, operation, nullable base/result payload SHA-256, classification                                                       |
| Relationship | `HAS_SECTION`               | `Article` to `Section`, section index                                                                                              |
| Relationship | `HAS_CHUNK`                 | `Article` to `Chunk`, section and chunk indexes                                                                                    |
| Relationship | `LINKS_TO`                  | `Section` to `Section`, link type                                                                                                  |
| Relationship | `HAS_ENTITY`                | `Article` to `Entity`; authoritative entity support                                                                                |
| Relationship | `ENTITY_RELATION`           | `Entity` to `Entity`, relation and context                                                                                         |
| HNSW index   | `Section.embedding_idx`     | `embedding`, 768 dimensions, cosine                                                                                                |
| HNSW index   | `Chunk.chunk_embedding_idx` | `embedding`, 768 dimensions, cosine                                                                                                |

The full CVE builder creates this schema, provenance, and the required live
Entity-to-Entity edges on a fresh baseline. It cannot upgrade a legacy pack;
update-capable baselines require the complete provenance schema.

A schema-v2 full-build baseline uses `lineage: { base: null, delta: null }`, an
`update` object with zero counts and an empty `records` array, null durable
base/delta fields, and no `UpdateApplication` rows. Its full-builder `buildId`
uses the same canonical field set as above with `baseContentDigest` and
`deltaId` both null. An incremental pack has non-null base and delta lineage
and exactly one application and manifest update record per delta key. Mixed
nullability is invalid.

Packs built before schema-v2, prototype packs, packs with incomplete source or
support cardinality, and packs whose adapter/extractor versions are
incompatible must be rebuilt from the source corpus. The updater never guesses
ownership or reconstructs provenance heuristically.

## Version compatibility

Complete update validation accepts only exact string schema version `"2"`.
Legacy manifests remain eligible for the shared structural checks in
`validateManifest`, but they are never eligible incremental bases. The CLI
invokes complete validation only when the loaded manifest declares exact string
`"2"`; other manifests receive only the shared structural checks.

The first v2 implementation has no implicit adapter or extractor migration. The
base's `adapterVersion` and `extractorVersion` must exactly equal identifiers in
the updater's explicit supported-version registry, and the updater must be able
to reproduce every stored `ArticleSource` with that pair. Unknown identifiers
and merely matching textual majors are incompatible. A future migration must
be added as an explicit `(from, to)` path and must change the schema or
component identifiers; it must not silently reinterpret existing records.

`toolVersion` identifies the producer and participates in the new `buildId`,
but a different base tool version is allowed when schema, adapter, and
extractor compatibility checks pass. Resume is stricter: all component and tool
versions saved in the workspace must exactly match the continuing process, so
an interrupted update is never resumed under changed code.

## Durable authority

LadybugDB is authoritative for:

- pack ID, version, schema/adapter/extractor/tool versions, and `buildId`;
- base pack ID, version, build ID, and content digest;
- semantic `deltaId`, raw delta-file SHA-256, and source provenance;
- canonical article payloads and hashes;
- per-key operation, nullable base/result hashes, and
  `added | modified | unchanged` classification;
- article/entity support, relation support, graph endpoints, and final live
  graph state.

Filesystem bytes are authoritative for each payload's exact size and SHA-256,
the aggregate `contentDigest`, and the set of files in the pack directory.

The update result and manifest are derived projections. Neither is an
authority. They are generated from reopened durable state and then compared
back to LadybugDB and filesystem bytes.

The durable records have these minimum fields:

| Record              | Required fields                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PackMetadata`      | singleton ID, pack ID/version, schema/adapter/extractor/tool versions, `buildId`, canonical provenance, nullable base pack ID/version/build ID/content digest, nullable `deltaId`, and nullable raw delta-file SHA-256 |
| `ArticleSource`     | stable article key, canonical payload bytes, payload SHA-256, and extractor version                                                                                                                                    |
| `UpdateApplication` | stable article key, `upsert` operation, nullable base payload SHA-256, result payload SHA-256, and `added \| modified \| unchanged` classification                                                                     |
| `HAS_ENTITY`        | source article and supported entity endpoints                                                                                                                                                                          |
| `RelationSupport`   | deterministic support ID/signature, source article, relation endpoints/type/context, and extractor version                                                                                                             |

Baseline packs use null base/delta fields and have no `UpdateApplication` rows.
Incremental packs have exactly one `UpdateApplication` row per delta key.

Each row must satisfy exactly one classification invariant:

| Classification | Operation | Base hash | Result hash                  |
| -------------- | --------- | --------- | ---------------------------- |
| `added`        | `upsert`  | null      | non-null                     |
| `modified`     | `upsert`  | non-null  | non-null and unequal to base |
| `unchanged`    | `upsert`  | non-null  | equal to base                |

## Schema-v2 manifest

The exported manifest contracts are:

```ts
type Sha256 = string;
type UpdateOperation = 'upsert';
type UpdateClassification = 'added' | 'modified' | 'unchanged';

interface PackManifest {
  name: string;
  version: string;
  description?: string;
  graph_stats?: GraphStats;
  eval_scores?: EvalScores;
  provenance?: PackProvenance;
  [extra: string]: unknown;
}

type PackLineageV2 =
  | {
      base: null;
      delta: null;
    }
  | {
      base: {
        packId: string;
        version: string;
        buildId: Sha256;
        contentDigest: Sha256;
      };
      delta: {
        deltaId: Sha256;
        fileSha256: Sha256;
      };
    };

interface PackUpdateRecordV2 {
  key: string;
  operation: 'upsert';
  basePayloadSha256: Sha256 | null;
  resultPayloadSha256: Sha256;
  classification: UpdateClassification;
}

interface PackUpdateV2 {
  added: number;
  modified: number;
  unchanged: number;
  records: PackUpdateRecordV2[];
}

interface PackFileMetadataV2 {
  path: string;
  size: number;
  sha256: Sha256;
}

interface PackManifestV2 extends PackManifest {
  packId: string;
  schemaVersion: '2';
  adapterVersion: string;
  extractorVersion: string;
  toolVersion: string;
  buildId: Sha256;
  lineage: PackLineageV2;
  update: PackUpdateV2;
  files: PackFileMetadataV2[];
  contentDigest: Sha256;
}
```

The structural types permit shared legacy fields and extensions. Runtime
schema-v2 validation additionally requires the provenance and whole-pack
statistics shown below, enforces a null base hash for `added`, unequal hashes
for `modified`, and equal hashes for `unchanged`.

A schema-v2 incremental output has this shape:

```json
{
  "name": "cve",
  "packId": "cve",
  "version": "2026.7.0",
  "schemaVersion": "2",
  "adapterVersion": "cve-adapter@2",
  "extractorVersion": "cve-adapter@2",
  "toolVersion": "agent-kgpacks-ts@0.1.0",
  "buildId": "7a44a7f870d799ad2fbd2d6ed5675d2651319bdea3f96af95db4c7f095712c1d",
  "provenance": {
    "corpus": {
      "name": "cvelistV5",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "date": "2026-07-16",
      "tag": "cve_2026-07-16_0000Z"
    },
    "embedding": {
      "model": "Xenova/bge-base-en-v1.5",
      "dimensions": 768
    },
    "build": {
      "tool_version": "agent-kgpacks-ts@0.1.0"
    }
  },
  "lineage": {
    "base": {
      "packId": "cve",
      "version": "2026.6.0",
      "buildId": "9edfe9c855f2637bf5f4f884487e91f8293198764584adcc3c5a8f5104eb704a",
      "contentDigest": "71d3afc5a14210a66fa538af86f5a03db760f62d64b1bbf5a9f6f9f01fc01d8d"
    },
    "delta": {
      "deltaId": "f10f0bf4a4b7c1014544cb9a386f887812b10f1712ba8f475f64608a411c9ec6",
      "fileSha256": "2e5751c026e543b2e8ab2eb06099daa1d3713d95ceadf4cb43725a513c7e1b1d"
    }
  },
  "update": {
    "added": 1,
    "modified": 0,
    "unchanged": 0,
    "records": [
      {
        "key": "CVE-2026-12345",
        "operation": "upsert",
        "basePayloadSha256": null,
        "resultPayloadSha256": "5036d889676e32a53a47d46a12653a6d37af21db9378f785b79190f9f784de26",
        "classification": "added"
      }
    ]
  },
  "graph_stats": {
    "articles": 343131,
    "sections": 343131,
    "chunks": 343131,
    "entities": 435208,
    "relationships": 512004,
    "entity_support": 941220,
    "relation_support": 512877,
    "source_records": 343131,
    "update_applications": 1,
    "payload_bytes": 5153960755,
    "size_mb": 4915.2
  },
  "files": [
    {
      "path": "pack.db",
      "size": 5153960755,
      "sha256": "8a0cb4774c4157ecb4ec1b87ff6c6432f3d8afc24a9f98702be36b0b392f0c93"
    }
  ],
  "contentDigest": "56633b42d85ab94fa0014d24715f715f2cb49f2e28df03f32d3a2d34fe3c9794"
}
```

Requirements:

- `@kgpacks/packs` exports `PackManifest`, `PackManifestV2`,
  `PackLineageV2`, `PackUpdateV2`, `PackUpdateRecordV2`,
  `PackFileMetadataV2`, `PackProvenance`, `GraphStats`, and the update
  operation/classification aliases.
- `validateManifest` validates the shared manifest fields and preserves
  schema-v2 extension fields without proving their complete shape or semantics.
  Exact string `schemaVersion: "2"` also enables the immutable version-token
  grammar.
- `name` and `packId` must be identical. A baseline has both lineage members
  null and an empty zero-count update. An incremental output has both lineage
  members non-null and non-empty or empty update records matching its delta;
  an empty delta therefore has non-null delta lineage but zero records.
- `graph_stats` describes the complete final pack, not the delta.
- IDs and digests are lowercase 64-character SHA-256 hex strings. Counts and
  byte sizes are safe non-negative integers; `size_mb` is finite and
  non-negative.
- `payload_bytes` is the exact sum of listed payload sizes. `size_mb` is a
  derived display value only.
- `files` is sorted by path. `contentDigest` is SHA-256 over the canonical,
  path-sorted `files` array.
- `manifest.json` is excluded from `files` and `contentDigest` to avoid a
  self-referential checksum.
- `update.records` is sorted by key and covers every delta record exactly once.
- Every update record carries operation, nullable base/result hashes, and a
  classification satisfying the invariant table above.
- Schema-v2 output contains only `pack.db` and `manifest.json`.
- Build metadata must not introduce current-time values into deterministic
  identity. Source-controlled dates may be retained as corpus provenance.

## Validation boundaries

### `validateManifest`

`@kgpacks/packs` `validateManifest(value)` is a synchronous structural gate. It
checks JSON field types, pack naming/version syntax, numeric ranges, and
prototype-pollution keys. It does not open LadybugDB, hash files, or establish
that identity, lineage, provenance, counts, and update records are truthful. It
does not completely validate the schema-v2 extension fields.

### Complete pack validation

`validateKnowledgePack(packDir)` is the complete schema-v2 entry point and
rejects any pack that is not exact schema version `"2"`. `wikigr pack validate`
loads the manifest first: it calls the complete validator for schema-v2 packs
and retains structural-only validation for legacy manifests.

Complete validation failures are reported as
`KnowledgePackValidationError`. The lower-level synchronous `validateManifest`
continues to throw `ManifestValidationError`.

The v2 validator reopens `pack.db` read-only and does not consume builder
summaries, sidecars, or checkpoints. It independently recomputes and verifies:

- metadata, provenance, `deltaId`, `buildId`, base linkage, and deterministic
  IDs against the singleton database metadata;
- canonical `ArticleSource` payload hashes and extractor reproduction for every
  article;
- all `UpdateApplication` rows and added/modified/unchanged counts;
- exact article, section, chunk, entity, live relationship, entity-support,
  relation-support, source, and application counts;
- source/application cardinality and uniqueness invariants;
- graph ownership, support signatures, endpoints, duplicates, and absence of
  orphaned or unsupported nodes and relationships;
- required table, column, primary-key, relationship, structured lexical, and
  vector-index definitions;
- exact independent index membership: every eligible live section/chunk appears
  once in its corresponding index and no stale row appears;
- reproduction of every article's derived sections, chunks, entities, and
  relations through the recorded extractor version;
- listed payload sizes and SHA-256 values, aggregate `contentDigest`, exact
  `payload_bytes`, and directory closure.

For a modified article, validation also proves that obsolete sections, chunks,
support rows, unsupported relations, unsupported entities, searchable text,
and vector-index entries are absent. Shared facts must remain while another
article supports them.

Every manifest identity, lineage, provenance, count, record, statistic, and
file field is checked against durable authority. Changing related fields
together must not make tampering pass.

Vector validation closes each index independently:

| Canonical live rows                                                     | Required index              |
| ----------------------------------------------------------------------- | --------------------------- |
| Unique `Section.id` values with valid finite 768-dimensional embeddings | `Section.embedding_idx`     |
| Unique `Chunk.id` values with valid finite 768-dimensional embeddings   | `Chunk.chunk_embedding_idx` |

For each pair, validation first rejects duplicate identities in the canonical
live rows, then keyset-scans those rows in pages of 256. It enumerates the
corresponding index with one overflow slot, rejects invalid or duplicate indexed
identities, and requires exact bidirectional set equality:

```text
canonical live identities ⊆ indexed identities
indexed identities ⊆ canonical live identities
```

The rule is identity closure, not count equality. Missing, stale, substituted,
and duplicate members fail even when counts match. Zero canonical live rows
require zero indexed identities, so empty-set closure is validated rather than
skipped. Passing one index never compensates for failure of the other.

## Resume and publication

Incremental resume uses `<work-dir>/update-state.json`; full-build resume uses a
different checkpoint and is not consulted.

The workspace layout is fixed:

```text
<work-dir>/
├── update-state.json
└── staging/
    ├── manifest.json
    └── pack.db
```

Only `staging/` is promoted to the output path. Keeping the sidecar outside that
directory makes promotion atomic while leaving enough state to recover a crash
immediately before or after promotion. Fresh mode requires the complete work
path to be absent; it never adopts or deletes pre-existing work.

Durable update state records:

- canonical base, delta, output, and work paths;
- target version and deterministic IDs;
- exact base manifest and `pack.db` hashes plus semantic/raw delta hashes;
- schema/extractor/tool versions and embedding-model identity;
- current durable phase;
- each delta ordinal, key, canonical payload hash, and advisory processed
  status.

Final articles are loaded in stable-key batches of 256. Each batch commits,
checkpoints LadybugDB, and then records sidecar progress. A fault after any
batch resumes from durable database evidence. Coverage uses 257 delta records,
compares the resumed graph with an uninterrupted run, and then compares the
finalized staged `pack.db` and `manifest.json` bytes with the published output.

Schema-v2 directory closure requires exactly `manifest.json` and `pack.db`, so
the two saved base hashes cover the complete eligible base tree. Resume
recomputes both hashes and the exact delta-file SHA-256 directly from bytes.

LadybugDB `UpdateApplication` rows and staged database state are authoritative
for completed application work. The sidecar is a recovery index. On resume, the
engine reconciles sidecar lag from durable database state; it never assumes
that sidecar progress proves a database commit. Before continuing, resume
re-canonicalizes every saved path and revalidates the sidecar schema, target
version, exact base tree and delta bytes, semantic `deltaId`, staged database,
durable applications, all recorded component versions, and the embedding model.

The durable phases are `prepared` and `delta-applied`. During `prepared`,
resume reconciles per-record sidecar status with staged source/application
evidence and continues in stable-key order. During `delta-applied`, resume
revalidates staging and retries no-replace publication. If publication already
completed, an equivalent output completes as a no-op; any other output fails.

After successful publication or equivalent-output recovery, the workspace is
removed. On failure it is retained only if it has reached one of the durable
phases above and independently passes resume validation; otherwise task-created
work is removed. A resumed call that discovers the prior call already published
the equivalent output returns `noop: true`.

Publication follows this order:

1. preflight all inputs and platform capabilities;
2. copy the complete base into same-filesystem staging;
3. transactionally apply records and rebuild generated indexes;
4. close, checkpoint, and reopen the staged database read-only;
5. generate projections from durable state and completely validate staging;
6. fsync payload files, the manifest, staging, and its parent directory;
7. recheck output collision and base/input immutability;
8. atomically promote staging with Linux
   `renameat2(RENAME_NOREPLACE)`;
9. fsync the output parent directory.

The package includes separate Linux x64 and arm64 helpers and selects the helper
for `process.arch`; installation does not compile native code. The selected
helper probes the target filesystem with the Linux `renameat2(RENAME_NOREPLACE)`
syscall, verifying both a preserved collision and a successful promotion. It
does not use Node.js `rename()` followed by a pre-check or permit a copy fallback.
If the platform or filesystem
cannot guarantee `RENAME_NOREPLACE`, the update fails before work starts. A
destination that appears during promotion is never replaced. After `RENAME_NOREPLACE` reports the collision, the engine completely validates
that destination and proves equivalence across request identity, lineage,
semantic/raw delta digests, manifest, database evidence, and filesystem bytes.
Only that comprehensive equivalence is a byte-preserving no-op; a matching
`buildId` alone is insufficient.

Existing output behavior:

| Destination                                                         | Result                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Comprehensively valid schema-v2 directory equivalent to the request | Return `noop: true`, change no bytes                                                       |
| Valid pack with another `buildId`                                   | Fail                                                                                       |
| Invalid directory or empty directory                                | Fail                                                                                       |
| File or symbolic link                                               | Fail                                                                                       |
| Destination appears during promotion                                | Apply the same comprehensive-equivalence no-op or mismatch-failure rules; never replace it |

The base tree must remain byte-identical after success, no-op, failure, and
resume. A failed fresh update leaves output absent. Work remains only when it
contains an intentional resumable checkpoint.

## Errors and exit codes

`@kgpacks/ingestion` exposes the typed failures. CLI outcomes are:

| Outcome                        | Meaning                                                                                                        | CLI exit |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------: |
| Success                        | Fresh publication, resume, or comprehensively equivalent no-op                                                 |      `0` |
| `KnowledgePackUpdateError`     | Expected update-domain failure: delta, base eligibility, resume mismatch, collision, or publication capability |      `7` |
| `KnowledgePackValidationError` | Complete pack validation failure                                                                               |      `4` |
| Commander usage error          | Missing, mixed, or unknown CLI options                                                                         |      `2` |
| Other error                    | Unexpected internal failure                                                                                    |      `1` |

Update failures emit a diagnostic on stderr and no success JSON. The CLI maps
error types, not message text.

During update, validation failures are wrapped as `KnowledgePackUpdateError`
and therefore exit `7`. Stdout remains empty for every failure. Both error
classes currently expose the normal `Error` fields (`name`, `message`, and
stack); callers branch on class or `name`, not message text.

```ts
declare class KnowledgePackUpdateError extends IngestionError {}
declare class KnowledgePackValidationError extends Error {}
```

## Related documentation

- [Incrementally update a CVE pack](../howto/incremental-cve-update.md)
- [CVE knowledge pack](../cve.md)
- [Resumable pack builds](../resumable-build.md)
- [Pack versioning and provenance](../pack-versioning.md)
- [`@kgpacks/packs` reference](../packages/packs.md)
