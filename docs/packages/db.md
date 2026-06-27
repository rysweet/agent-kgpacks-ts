# `@kgpacks/db`

A minimal, strict-ESM wrapper around [`@ladybugdb/core`](https://www.npmjs.com/package/@ladybugdb/core)
— the official Node binding for **LadybugDB** (a Kùzu-derived embedded graph
database with vector and full-text search extensions). In Phase 0 this package
provides just enough surface to open a database, run Cypher, load extensions, and
clean up — plus the **first slice of Spike A**, a synthetic vector smoke test that
exercises the vector path from Node.

> **The read path is already de-risked.** Storage compatibility is proven: Node
> `@ladybugdb/core` 0.17.1 (storage v41) reads Python `real_ladybug` 0.15.3
> (storage v40) packs — including `LOAD EXTENSION VECTOR/FTS` and
> `QUERY_VECTOR_INDEX` over Python-built HNSW indexes — with no rebuild or
> migration. The open Spike A risk is the **concurrency model**, not the read
> path (see [Spike A](#spike-a-vector-smoke-test) below).

- **Runtime dependency:** `@ladybugdb/core` pinned to **`0.17.1`** (exact, no
  range). The lockfile is committed for reproducible installs. `0.17.1` (storage
  v41) is chosen over the `0.15.x` line because v41 reads existing Python-built
  v40 packs directly with no migration; the matching `0.15.x` Node builds remain
  available if exact storage parity is later preferred.
- **No build toolchain required:** `0.17.1` ships a prebuilt
  `@ladybugdb/core-linux-x64` (and peers for other platforms) via
  `optionalDependencies`. Install only _selects and links_ the prebuilt binary for
  the current platform — nothing is compiled from source.
- **Module system:** native ESM. Import named exports directly.

> **API stability caveat.** The `Database` / `Connection` surface and the exact
> Cypher `CALL` / extension-load signatures in this document describe the
> wrapper's _intended_ surface. They are **subject to verification against
> `@ladybugdb/core@0.17.1`**: the raw Kùzu-style binding may expose a different
> shape (e.g. `new Connection(db)` + `query()` + `getAll()`), and the exact
> procedure names/arguments are confirmed empirically by Spike A and then
> back-filled here. Treat the signatures below as the target, not a settled fact.

> Scope note: this is the _only_ Phase 0 package with logic, and that logic is
> limited to the thin wrapper plus the Spike A vector smoke-test slice. The full
> connection manager, parameter helpers, concurrency model, and Cypher-RAG safety
> validation arrive in Phase 1 (see [docs/PLAN.md](../PLAN.md)).

## Installation

`@kgpacks/db` is an internal workspace package; you normally consume it from
other `@kgpacks/*` packages via a workspace dependency:

```jsonc
// packages/<consumer>/package.json
{
  "dependencies": {
    "@kgpacks/db": "workspace:*",
  },
}
```

From the repo root:

```bash
pnpm install
pnpm --filter @kgpacks/db build
pnpm --filter @kgpacks/db test   # runs Spike A
```

## Quick start

```ts
import { Database } from '@kgpacks/db';

// Open an in-memory database (path defaults to ':memory:').
const db = new Database();
const conn = db.connect();

// Load the vector extension (issues the INSTALL + LOAD EXTENSION sequence).
await conn.loadExtension('vector');

// Run Cypher. Parameters are bound, never string-interpolated.
await conn.run('CREATE NODE TABLE Doc(id INT64, embedding FLOAT[4], PRIMARY KEY(id))');
await conn.run('CREATE (:Doc {id: $id, embedding: $vec})', {
  id: 1,
  vec: [0.1, 0.2, 0.3, 0.4],
});

const rows = await conn.run('MATCH (d:Doc) RETURN d.id AS id');
console.log(rows); // [{ id: 1 }]

conn.close();
db.close();
```

To open an on-disk database, pass a path:

```ts
const db = new Database('./packs/example.lbug');
```

## API reference

### `class Database`

A thin handle over a LadybugDB instance.

#### `new Database(path?: string, options?: DatabaseOptions)`

Opens (or creates) a database.

| Parameter | Type              | Default      | Description                                                                           |
| --------- | ----------------- | ------------ | ------------------------------------------------------------------------------------- |
| `path`    | `string`          | `':memory:'` | Filesystem path to the database, or `':memory:'` for an ephemeral in-memory instance. |
| `options` | `DatabaseOptions` | `{}`         | Engine tuning; omitted fields use the engine defaults.                                |

`DatabaseOptions` forwards a subset of the underlying engine's `SystemConfig`:
`bufferPoolSize`, `enableCompression`, `readOnly`, `maxDBSize`, `autoCheckpoint`,
`checkpointThreshold`. The notable one for bulk loads is **`autoCheckpoint:
false`**: with automatic checkpoints on, every committed write batch can trigger
checkpoint work whose cost grows with the database size, turning a large
streaming load into ~O(N²); off, writes only append to the WAL during the load
and a single checkpoint is taken at `close()` (kept linear). The CVE pack builder
(`scripts/build-cve-pack.mjs`) uses this. `close()` still checkpoints, so the
file remains self-contained (no `.wal` sidecar) for distribution.

#### `database.connect(): Connection`

Returns a new [`Connection`](#class-connection) bound to this database.

> **Concurrency (unresolved):** the Python backend used a per-request
> `Connection` plus a thread pool because connections are not thread-safe.
> Whether `@ladybugdb/core` allows concurrent async queries on one `Connection`,
> or whether the backend needs a **connection pool / `worker_threads`**, is the
> open question of **Spike A** — and the scaffold's vector slice does **not**
> settle it. Until Spike A delivers that decision, use one connection per logical
> unit of work and assume connections are not safe for concurrent in-flight
> queries (see [docs/PLAN.md](../PLAN.md)).

#### `database.close(): void`

Closes the database and releases native resources. Idempotent — calling it more
than once is safe.

### `class Connection`

Executes Cypher against an open `Database`.

#### `connection.run<T = Record<string, unknown>>(cypher, params?): Promise<T[]>`

Executes a Cypher statement and returns all result rows as plain objects.

| Parameter | Type                                   | Description                                                                                                                          |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cypher`  | `string`                               | The Cypher statement to execute.                                                                                                     |
| `params`  | `Record<string, unknown>` _(optional)_ | Named parameters referenced as `$name` in the statement. Values are **bound by the driver, never interpolated** into the query text. |

Returns a promise resolving to an array of row objects keyed by the statement's
`RETURN` aliases.

```ts
const rows = await conn.run('MATCH (d:Doc) WHERE d.id = $id RETURN d.id AS id', { id: 42 });
```

> **Security:** always pass user-controlled values through `params`. Never build
> Cypher by concatenating untrusted strings — the Phase 1 Cypher-RAG safety
> validator depends on this discipline.

#### `connection.loadExtension(name: string): Promise<void>`

Installs and loads a LadybugDB extension. The wrapper issues the documented
install/load sequence — `INSTALL <name>; LOAD EXTENSION <name>;` — so callers
don't repeat it.

| Parameter | Type     | Description                                 |
| --------- | -------- | ------------------------------------------- |
| `name`    | `string` | Extension name, e.g. `'vector'` or `'fts'`. |

```ts
await conn.loadExtension('vector');
await conn.loadExtension('fts');
```

> **Pending verification (R3):** the exact extension-load statements — whether
> `LOAD EXTENSION <name>` (as in [docs/PLAN.md](../PLAN.md)) or the shorter
> `LOAD <name>`, and whether `INSTALL` is required at all for the bundled VECTOR/
> FTS extensions — are confirmed against `@ladybugdb/core@0.17.1` by Spike A and
> then back-filled here. The wrapper's _contract_ (one call that makes the
> extension usable) is stable; the SQL it emits may be adjusted to match the
> binding.

> `INSTALL` may fetch the extension over HTTPS the first time it is used. CI
> runners need outbound network access for this step; the call fails closed
> (rejects) with a clear error if the extension cannot be obtained.

#### `connection.close(): void`

Closes the connection and releases its native resources. Idempotent.

## Vector index helpers (Cypher)

LadybugDB exposes vector indexing through Cypher `CALL` procedures. The wrapper
does not abstract these in Phase 0 — you call them directly via
`connection.run`. The two procedures used by Spike A:

> **Pending verification (R3).** The procedure names and argument forms shown
> below (`CREATE_VECTOR_INDEX(...)`, `QUERY_VECTOR_INDEX(...)`, the `metric :=`
> keyword argument, and the `node`/`distance` yield columns) describe the
> _intended_ call shape. They are **not yet confirmed for `@ladybugdb/core@0.17.1`**
> — public sources disagree on the exact signatures, so Spike A verifies them
> empirically and this section is then corrected to the real forms. Use these as
> the target, not authoritative API.

### `CREATE_VECTOR_INDEX`

Builds an HNSW index over a `FLOAT[N]` column.

```ts
await conn.run(`CALL CREATE_VECTOR_INDEX('Doc', 'doc_vec_idx', 'embedding', metric := 'cosine')`);
```

| Argument             | Meaning                               |
| -------------------- | ------------------------------------- |
| `'Doc'`              | Node table containing the vectors.    |
| `'doc_vec_idx'`      | Name to give the new index.           |
| `'embedding'`        | The `FLOAT[N]` property to index.     |
| `metric := 'cosine'` | Distance metric. Spike A uses cosine. |

### `QUERY_VECTOR_INDEX`

Returns the `k` nearest neighbors to a query vector, ordered by distance.

```ts
const neighbors = await conn.run(
  `CALL QUERY_VECTOR_INDEX('Doc', 'doc_vec_idx', $query, $k)
   RETURN node.id AS id, distance AS distance
   ORDER BY distance`,
  { query: [0.1, 0.2, 0.3, 0.4], k: 3 },
);
// neighbors[0] is the closest match; smaller cosine distance = more similar.
```

The procedure yields `node` (the matched node) and `distance` (cosine distance
for a cosine index). Lower distance means higher similarity, so
`ORDER BY distance` ascending puts the nearest neighbor first.

## Spike A: vector smoke test

> **Scope — this is one slice, not all of Spike A.** [docs/PLAN.md](../PLAN.md)
> defines Spike A as **"DB read + concurrency"**: open a _real existing pack DB_
> from Node; run **vector + FTS + graph** queries; **and settle the concurrency
> model** (whether `@ladybugdb/core` supports concurrent async queries on one
> `Connection`, or whether the backend needs a connection pool / `worker_threads`).
> The slice shipped here is a **synthetic, in-memory, vector-only** smoke test.
> The remainder of Spike A — real-pack read, FTS + graph queries, and the
> concurrency-model decision — is **still outstanding** and is what actually
> clears the Phase 0 go/no-go gate.

This slice lives at `packages/db/test/spike-a.test.ts` and runs as part of
`pnpm --filter @kgpacks/db test` (and therefore `pnpm -r test` and CI).

### What it proves

This slice exercises the vector path from Node end-to-end: load the VECTOR
extension, build a cosine HNSW index, and confirm a query returns correctly
cosine-ranked neighbors via the wrapper's API. The read path itself is **already
de-risked** by proven storage compatibility (see the note at the top of this
page); this slice simply confirms the same operations drive cleanly from the
wrapper and that the (unverified) index `CALL` signatures actually work against
`0.17.1`.

> **Spike A kill criterion (verbatim, [docs/PLAN.md](../PLAN.md)):**
> _"Kill: cannot reproduce a known query's results."_ — with the plan's note that
> the read path is already de-risked and **concurrency is the open question**. The
> synthetic ranking assertion below is this slice's local success check, not the
> full kill criterion.

The slice, end to end:

1. Opens an **in-memory** LadybugDB (`new Database()`).
2. Loads the VECTOR extension via `loadExtension('vector')` (exact load SQL
   pending verification — see the [`loadExtension`](#vector-index-helpers-cypher)
   note above).
3. Creates a small node table with a fixed-width `FLOAT[N]` embedding column.
4. Inserts a handful of rows with known vectors.
5. Builds an HNSW index with `CREATE_VECTOR_INDEX(..., metric := 'cosine')`.
6. Queries it with `QUERY_VECTOR_INDEX(..., k)` for a chosen query vector.
7. **Asserts** the returned neighbors are the correct **cosine-ranked** nearest
   neighbors, in the expected order.

Because the dataset is tiny, the HNSW search is effectively exact, so the
nearest-neighbor ordering is **deterministic** and safe to assert on.

### Annotated walkthrough

The following mirrors the shape of the committed test (a real run lives in the
repository; this is the documented specification of its behavior):

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { Database } from '../src/index.js';

describe('Spike A — LadybugDB vector index', () => {
  const db = new Database(); // in-memory
  const conn = db.connect();

  afterAll(() => {
    conn.close();
    db.close();
  });

  it('returns cosine-ranked nearest neighbors', async () => {
    // 1. Vector extension.
    await conn.loadExtension('vector');

    // 2. Node table with a 4-dimensional FLOAT embedding.
    await conn.run('CREATE NODE TABLE Doc(id INT64, embedding FLOAT[4], PRIMARY KEY(id))');

    // 3. Seed a few documents with known vectors.
    const docs = [
      { id: 1, vec: [1.0, 0.0, 0.0, 0.0] },
      { id: 2, vec: [0.9, 0.1, 0.0, 0.0] }, // close to the query
      { id: 3, vec: [0.0, 1.0, 0.0, 0.0] }, // orthogonal-ish
      { id: 4, vec: [0.0, 0.0, 0.0, 1.0] }, // far from the query
    ];
    for (const d of docs) {
      await conn.run('CREATE (:Doc {id: $id, embedding: $vec})', {
        id: d.id,
        vec: d.vec,
      });
    }

    // 4. Build the cosine HNSW index.
    await conn.run(
      `CALL CREATE_VECTOR_INDEX('Doc', 'doc_vec_idx', 'embedding', metric := 'cosine')`,
    );

    // 5. Query for the 3 nearest neighbors of a vector near doc 1/2.
    const query = [1.0, 0.05, 0.0, 0.0];
    const rows = await conn.run(
      `CALL QUERY_VECTOR_INDEX('Doc', 'doc_vec_idx', $query, $k)
       RETURN node.id AS id, distance AS distance
       ORDER BY distance`,
      { query, k: 3 },
    );

    // 6. Assert correct cosine ranking: doc 1 and doc 2 are nearest,
    //    doc 4 (orthogonal in the last axis) is not in the top results.
    const rankedIds = rows.map((r) => r.id);
    expect(rankedIds.slice(0, 2).sort()).toEqual([1, 2]);
    expect(rankedIds).not.toContain(4);

    // 7. Distances are non-decreasing (nearest first).
    const distances = rows.map((r) => r.distance as number);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });
});
```

### Running it

```bash
pnpm --filter @kgpacks/db test
# or, as part of the whole workspace:
pnpm -r test
```

### Troubleshooting

| Symptom                                                         | Likely cause                                                           | Fix                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `loadExtension('vector')` rejects with a download/network error | The runner has no outbound HTTPS access to fetch the VECTOR extension. | Allow egress for the test job; the call fails closed by design.                          |
| `Cannot find module '@ladybugdb/core-linux-x64'`                | The platform-specific prebuilt optional dependency didn't install.     | Re-run `pnpm install`; confirm the platform is supported (linux/darwin/win × x64/arm64). |
| `ERR_MODULE_NOT_FOUND` for a local import                       | Missing `.js` extension on a relative import under `NodeNext`.         | Import compiled paths, e.g. `'../src/index.js'`.                                         |

## See also

- [docs/monorepo.md](../monorepo.md) — workspace layout, scripts, configuration,
  and CI.
- [docs/PLAN.md](../PLAN.md) — Phase 0 spikes (including Spike A's kill
  criterion) and the full port plan.
