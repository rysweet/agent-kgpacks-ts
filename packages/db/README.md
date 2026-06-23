# @kgpacks/db

A minimal, strict-ESM wrapper around [`@ladybugdb/core`](https://www.npmjs.com/package/@ladybugdb/core)
— the Node binding for **LadybugDB**, a Kùzu-derived embedded graph database with
vector and full-text-search extensions. In Phase 0 this package provides just
enough surface to open a database, run Cypher, load extensions, and clean up, plus
the **first slice of Spike A** — a synthetic vector smoke test that exercises the
vector path (cosine HNSW index → nearest-neighbour query) end to end from Node.

`@ladybugdb/core` is pinned to the exact version **`0.17.1`** (no range) and the
lockfile is committed for reproducible installs. It ships prebuilt native binaries
via platform `optionalDependencies`, so **no C/C++ toolchain is required**.

This is the only Phase 0 package carrying logic, and that logic is limited to the
thin wrapper plus the Spike A slice. See
[docs/packages/db.md](../../docs/packages/db.md) for the full API reference and the
Spike A walkthrough, and [docs/PLAN.md](../../docs/PLAN.md) for the port plan.
