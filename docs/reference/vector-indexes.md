---
title: Knowledge-pack vector index contract
description: Reference for the fixed LadybugDB HNSW indexes built for Section and Chunk embeddings
last_updated: 2026-07-24
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: reference
---

# Knowledge-pack vector index contract

Knowledge-pack builders create two fixed cosine HNSW indexes after all embeddings
have been loaded. The same definitions apply to fresh builds and incremental
rebuilds.

## Index definitions

| Node table | Index name            | Property    | Dimensions | Type   | Metric   | Builder `pu`         |
| ---------- | --------------------- | ----------- | ---------: | ------ | -------- | -------------------- |
| `Section`  | `embedding_idx`       | `embedding` |        768 | `HNSW` | `cosine` | `0.9999999999999999` |
| `Chunk`    | `chunk_embedding_idx` | `embedding` |        768 | `HNSW` | `cosine` | `0.9999999999999999` |

The generated LadybugDB statements are:

```cypher
CALL CREATE_VECTOR_INDEX(
  'Section',
  'embedding_idx',
  'embedding',
  metric := 'cosine',
  pu := 0.9999999999999999
)

CALL CREATE_VECTOR_INDEX(
  'Chunk',
  'chunk_embedding_idx',
  'embedding',
  metric := 'cosine',
  pu := 0.9999999999999999
)
```

`pu` controls HNSW upper-layer sampling. LadybugDB requires this value to be
strictly less than `1`. The builder uses the largest IEEE-754 binary64 value
below `1` to request effectively complete upper-layer sampling while satisfying
that constraint.

This exact `pu` is generated builder behavior, not a persisted-pack
compatibility requirement. `validateKnowledgePack` does not inspect `pu` and
does not reject an otherwise valid pack solely because its catalog records a
different value.

The existing `Section.id` and `Chunk.id` primary keys remain the identity and
uniqueness constraints. The indexes add retrieval structures only; they add no
new data constraints or relationships.

## Build lifecycle

### Fresh build

The builder:

1. loads the LadybugDB `vector` extension;
2. creates schema-v2 node and relationship tables;
3. loads nodes, relationships, and 768-dimensional embeddings;
4. builds both indexes during loader finalization.

Building the indexes after loading prevents each insert from paying index
maintenance cost and ensures the index covers the final live row set.

### Incremental update

An incremental update materializes the base-plus-delta state in staging from an
eligible schema-v2 base. It does not migrate or change the logical schema.

When resuming a `prepared` staging database, the updater:

1. reuses the existing schema-v2 tables;
2. discovers current indexes and drops only the allowlisted
   `Section.embedding_idx` and `Chunk.chunk_embedding_idx` pairs;
3. clears generated `ENTITY_RELATION` and `LINKS_TO` relationships plus
   `UpdateApplication` and `PackMetadata` records;
4. reconciles staged `ArticleSource` hashes and copies only missing articles;
5. rebuilds both indexes during writer finalization;
6. validates the completed staging database before publication.

Catalog discovery never authorizes arbitrary identifier interpolation. Only the
two exact table/index pairs above can be passed to `DROP_VECTOR_INDEX`.

A `delta-applied` resume does not rebuild indexes. Finalization and validation
already completed before that durable phase, so the updater revalidates staging
and retries no-replace publication.

## Public TypeScript API

`@kgpacks/ingestion` exports the fixed schema constants and loader helpers:

| Export                  | Type or signature                                    | Contract                                                          |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `EMBEDDING_DIM`         | `768`                                                | Fixed embedding width for both indexed properties.                |
| `SECTION_TABLE`         | `'Section'`                                          | Section node-table name.                                          |
| `SECTION_VECTOR_INDEX`  | `'embedding_idx'`                                    | Section vector-index name used by the query path.                 |
| `CHUNK_TABLE`           | `'Chunk'`                                            | Chunk node-table name.                                            |
| `CHUNK_VECTOR_INDEX`    | `'chunk_embedding_idx'`                              | Chunk vector-index name.                                          |
| `VECTOR_INDEX_DDL`      | `readonly string[]`                                  | The two ordered `CREATE_VECTOR_INDEX` statements shown above.     |
| `buildVectorIndexes`    | `(connection: Connection) => Promise<void>`          | Executes every statement in `VECTOR_INDEX_DDL`.                   |
| `loadPack`              | `(connection, input) => Promise<LoadPackStats>`      | Loads a complete in-memory input and then builds both indexes.    |
| `createPackWriter`      | `(connection, options?) => Promise<PackWriter>`      | Returns a streaming writer whose `finalize()` builds the indexes. |
| `validateKnowledgePack` | `(packDir: string) => Promise<PackValidationResult>` | Performs complete schema-v2 validation, including index checks.   |

`buildVectorIndexes` expects the `vector` extension, node tables, embedding
properties, and rows to exist. Normal builders satisfy those preconditions;
applications do not need to call it separately.

## Configuration

There are no CLI flags or environment variables for index name, type, metric,
dimensions, or `pu`. Supported builders always use the definitions above.

Pack validation requires exactly the two named HNSW indexes, each over its
`embedding` property with cosine distance. The table schema fixes each embedding
at 768 dimensions. Validation does not inspect `pu`; it remains an internal
index-build setting rather than a pack compatibility criterion.

The index setting does not change schema version `2` and requires no migration.
Process-level Node.js options, including heap sizing through `NODE_OPTIONS`, do
not alter the index definition.

## Inspect a built pack

Run complete validation for the supported operator check:

```bash
wikigr --packs-dir data/releases/2026.07 pack validate cve
```

To inspect the LadybugDB catalog from TypeScript:

```ts
import { Database } from '@kgpacks/db';

const database = new Database('data/releases/2026.07/cve/pack.db', {
  readOnly: true,
});
const connection = database.connect();

try {
  await connection.loadExtension('vector');
  const indexes = await connection.run(
    `CALL SHOW_INDEXES()
     RETURN table_name AS tableName,
            index_name AS indexName,
            index_type AS indexType,
            property_names AS propertyNames,
            index_definition AS definition
     ORDER BY tableName, indexName`,
  );
  console.log(indexes);
} finally {
  connection.close();
  database.close();
}
```

The catalog must contain exactly the two indexes listed in
[Index definitions](#index-definitions). Complete pack validation requires
`HNSW`, the `embedding` property, and cosine distance for both. The centralized
DDL supplies the documented `pu` value on every supported build path, but the
validator does not compare that value.

## Related documentation

- [Incremental knowledge-pack update contract](incremental-update.md)
- [Incrementally update a CVE knowledge pack](../howto/incremental-cve-update.md)
- [`@kgpacks/db` reference](../packages/db.md)
- [`@kgpacks/ingestion` package](../../packages/ingestion/README.md)
