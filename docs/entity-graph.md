# Entity-graph traversal

Knowledge packs are more than a flat list of documents: as they are built, the
ingestion pipeline extracts **entities** (for the CVE pack: CWE weaknesses,
vendors, products, and the vulnerability itself) and the relationships among them.
The entity graph makes that structure a **first-class, scalable retrieval feature**
— you can start from an entity and traverse to related entities and the documents
that mention them.

This document covers the two surfaces that expose it: the `@kgpacks/query`
`entityGraph()` core and the backend `GET /api/v1/graph/entities` route. It also
covers how packs are built so the traversal scales to the full 343k-record CVE
pack.

## The graph model

The pack schema (see [`@kgpacks/packs`](packages/packs.md)) materializes:

| Element                                   | Meaning                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Entity {entity_id, name, type, …}`       | A CWE (`weakness`), vendor (`organization`), `product`, or `vulnerability` node. `entity_id` equals the trimmed `name`. |
| `(:Article)-[:HAS_ENTITY]->(:Entity)`     | A document (CVE record) mentions an entity.                                                                             |
| `(:Entity)-[:ENTITY_RELATION]->(:Entity)` | A typed relationship between two entities (`relation`, `context`).                                                      |

An **entity neighborhood** is the set of entities reachable within _N_ hops of a
seed entity, plus the articles that connect them.

### Two traversal modes

Because the CVE builder **skips `ENTITY_RELATION` edges by default** (they are
expensive to build and, historically, unused — see [docs/cve.md](cve.md)),
`entityGraph()` supports two modes and **auto-selects**:

| Mode            | Uses                                                                   | When                                                            |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `relation`      | Direct `ENTITY_RELATION` edges.                                        | The pack was built `--with-entity-relations` (edges exist).     |
| `co-occurrence` | Two entities are linked if some article `HAS_ENTITY` **both** of them. | The pack has no `ENTITY_RELATION` edges (the CVE-pack default). |

With `mode: 'auto'` (the default), the core probes for `ENTITY_RELATION` edges once
and picks `relation` if any exist, otherwise `co-occurrence`. This means the
feature works on the **stock** CVE pack (co-occurrence over shared CVEs — e.g. two
products both affected by the same vulnerability) and gets richer, typed edges for
free on packs built with relations.

## `@kgpacks/query` — `entityGraph()`

The transport-agnostic core. It takes a `Connection` (from `@kgpacks/db`) and an
options object and returns the neighborhood.

```ts
import { entityGraph } from '@kgpacks/query';
import { Database } from '@kgpacks/db';

const db = new Database('/home/alice/.local/share/kgpacks/cve/pack.db');
const conn = db.connect();

const graph = await entityGraph(conn, {
  entity: 'CWE-79', // seed entity name (or entity_id)
  depth: 2, // 1..3 hops
  limit: 50, // max entities returned
  type: 'product', // optional: restrict neighbors to one entity type
  mode: 'auto', // 'auto' | 'relation' | 'co-occurrence'
});

console.log(graph.nodes.length, 'entities', graph.edges.length, 'edges');
```

### Options

| Field    | Type                                      | Default  | Meaning                                                                                         |
| -------- | ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `entity` | `string`                                  | —        | Seed entity `name` or `entity_id`. Required.                                                    |
| `depth`  | `number` (1–3)                            | `1`      | Hop count. Validated to `1..3`; out-of-range throws.                                            |
| `limit`  | `number` (1–200)                          | `50`     | Max neighbor entities (deterministic order).                                                    |
| `type`   | `string`                                  | —        | Restrict neighbors to one entity type (`weakness`, `product`, `organization`, `vulnerability`). |
| `mode`   | `'auto' \| 'relation' \| 'co-occurrence'` | `'auto'` | Traversal strategy (see above).                                                                 |

### Result shape

```ts
interface EntityGraphResult {
  seed: string;
  mode: 'relation' | 'co-occurrence';
  nodes: EntityNode[]; // { id, name, type, depth, articles_count }
  edges: EntityEdge[]; // { source, target, relation, weight }
  total_nodes: number;
  total_edges: number;
  execution_time_ms: number;
}
```

Results are **bounded and deterministic**: neighbors are ordered by `(depth ASC,
name ASC)` and capped at `limit`; hub fan-out (an entity shared by thousands of
CVEs) is frontier-capped so a high-degree seed cannot blow up the response. Only
the validated `1..3` depth is interpolated into the path pattern; every other value
is a bound `$parameter`, so the traversal is injection-safe (matching the article
graph service).

## Backend — `GET /api/v1/graph/entities`

The route exposes the same neighborhood over HTTP, next to the existing
`GET /api/v1/graph` (article graph).

### Request

| Query param | Type    | Default | Bounds      | Meaning                                  |
| ----------- | ------- | ------- | ----------- | ---------------------------------------- |
| `entity`    | string  | —       | ≤ 500 chars | Seed entity name/id. **Required.**       |
| `depth`     | integer | `1`     | `1`–`3`     | Hop count.                               |
| `limit`     | integer | `50`    | `1`–`200`   | Max neighbor entities.                   |
| `type`      | string  | —       | ≤ 200 chars | Optional entity-type filter.             |
| `mode`      | string  | `auto`  | enum        | `auto` \| `relation` \| `co-occurrence`. |

A validation failure returns the standard `400` envelope (`MISSING_PARAMETER` /
`INVALID_PARAMETER`); an unknown seed entity returns `404` (`Entity not found`).

### Response

```jsonc
// GET /api/v1/graph/entities?entity=CWE-79&depth=2&limit=25
{
  "seed": "CWE-79",
  "mode": "co-occurrence",
  "nodes": [
    { "id": "CWE-79", "name": "CWE-79", "type": "weakness", "depth": 0, "articles_count": 18420 },
    {
      "id": "WordPress",
      "name": "WordPress",
      "type": "product",
      "depth": 1,
      "articles_count": 5124,
    },
    // …
  ],
  "edges": [
    { "source": "CWE-79", "target": "WordPress", "relation": "co_occurs", "weight": 5124 },
    // …
  ],
  "total_nodes": 25,
  "total_edges": 40,
  "execution_time_ms": 22.7,
}
```

### Example

```bash
# Start the backend against the installed CVE pack
WIKIGR_DATABASE_PATH=~/.local/share/kgpacks/cve/pack.db \
  node packages/backend/dist/index.js

# Query the entity neighborhood of a CWE weakness
curl 'http://127.0.0.1:8000/api/v1/graph/entities?entity=CWE-89&depth=2&type=product&limit=10'
```

The route is `contents: read`-only, rate-limited, cache-controlled, and CORS/CSP
governed exactly like the other `/api/v1` routes (see
[docs/packages/backend.md](packages/backend.md)). It never mutates the pack.

## Building a pack with a scalable entity graph

The bottleneck historically was **loading** `ENTITY_RELATION` edges: a naive
two-pattern `MATCH` over the growing `Entity` table is O(N²) and dominated finalize
on the full corpus. The builder now loads entity-entity edges with a **scalable
bulk path**:

- **Preferred:** a bulk `COPY REL FROM` of a staged edge list, when the engine
  supports it (probed once at finalize).
- **Fallback:** a **PK-indexed, single-`MATCH` `UNWIND`** in bounded chunks (the
  same ~linear technique PR #69 used for `HAS_ENTITY`/`HAS_SECTION`), never the
  comma two-pattern `MATCH` that regressed to O(N²).

Enable relation edges at build time (still off by default, because co-occurrence
traversal already works without them):

```bash
pnpm cve:build --src .scratch/cve/cves --with-entity-relations
```

`--with-entity-relations` now scales to the full corpus (linear finalize) instead
of being a multi-hour super-linear step. The default build remains fast and its
packs still support the entity graph via co-occurrence.

> **Compatibility.** Adding the entity-graph read path does **not** change existing
> retrieval: vector/hybrid `query`, the article graph, search, and chat return
> byte-identical results. The entity graph is a purely additive read surface.

## Related docs

- [docs/packages/backend.md](packages/backend.md) — the full `/api/v1` route contract.
- [docs/cve.md](cve.md) — CVE entity mapping & the build pipeline.
- [docs/resumable-build.md](resumable-build.md) — resumable/pipelined pack builds.
