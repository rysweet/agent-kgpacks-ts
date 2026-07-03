# Resumable & pipelined pack builds

Building the full CVE pack embeds ~343k records on CPU (~10–15 texts/sec) — an
overnight batch. Two improvements make that batch robust and faster **without
changing the resulting pack**:

- **Resumable** — a build that is interrupted (crash, preemption, `Ctrl-C`, a full
  disk) can **resume from the last committed batch** instead of starting over.
- **Pipelined** — embedding (parallelizable, CPU-bound) and DB load (serial) run
  **concurrently**, so cores are not idle waiting for the loader between batches.

Both apply to `scripts/build-cve-pack.mjs` (the `pnpm cve:build` entry point). The
output `pack.db` is **identical** whether or not a build was resumed or pipelined.

## Resumable builds

### The checkpoint sidecar

As it makes durable progress, the builder writes a `<out>.build-checkpoint.json`
sidecar next to the output pack (e.g. `data/packs/cve/pack.db.build-checkpoint.json`).
It records exactly what has been durably loaded:

```jsonc
{
  "version": 1,
  "batchIndex": 1284, // last durably-checkpointed batch
  "sourceOffset": 123264, // position in the deterministic record scan
  "tmpOut": "data/packs/cve/pack.db.building-9f2c…", // the partial build DB to reopen
  "counts": { "articles": 123264, "skipped": 0 },
  "paramsHash": "9f2c…", // hash of build params (see below)
  "updatedAt": "2025-06-15T02:41:07Z",
}
```

Each batch is loaded in its own atomic `BEGIN…COMMIT` transaction (so a crash
mid-batch rolls back cleanly), and every `--checkpoint-every` batches (default 50)
the builder forces a durable **`CHECKPOINT`** (flushing the WAL into the main DB)
**before** writing the sidecar. So the sidecar never claims progress that would not
survive losing the WAL — a crash costs at most one checkpoint interval of re-work,
never the whole build. On a clean finish the sidecar is removed.

### Resuming

Re-run the **same command** with `--resume` (or just re-run — resume is the default
when a valid checkpoint is present for the same output and parameters):

```bash
# First run (interrupted at batch 1284 of ~3600)
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db

# Resume from the checkpoint — skips the first 123,264 records
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db --resume

# Force a clean rebuild, ignoring/overwriting any checkpoint
pnpm cve:build --src .scratch/cve/cves --out data/packs/cve/pack.db --no-resume
```

| Flag                 | Default                                  | Meaning                                                                                  |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--resume`           | auto (on when a valid checkpoint exists) | Continue from the last checkpointed batch.                                               |
| `--no-resume`        | —                                        | Ignore any checkpoint and rebuild from scratch (truncates output).                       |
| `--checkpoint-every` | `50`                                     | Batches between durable checkpoints + sidecar writes (crash re-work is bounded by this). |

### What resume does

On resume the builder:

1. **Validates the parameters hash.** The checkpoint records a hash of the inputs
   that affect output (source path, `--year`, `--limit`, `--batch`, embedding
   model, `--with-entity-relations`). If the current parameters do not match, the
   builder **refuses to resume** and tells you to `--no-resume` — a checkpoint from
   a different build can never corrupt a new one. (Resume is also refused for a
   `--with-entity-relations` build: those Entity→Entity edges are materialized in a
   single final pass and cannot be reconstructed from a mid-build checkpoint.)
2. **Discards the temp DB's WAL.** An abrupt crash can leave a torn trailing WAL
   record that LadybugDB refuses to replay. The checkpointed **main** DB (all
   batches up to the last sidecar) is intact, so the build reopens the recorded
   `tmpOut` after deleting its `.wal`, losing only the interrupted (un-checkpointed)
   interval.
3. **Skips schema recreation.** `createSchema` runs only on a fresh build; on resume
   the existing tables/indexes are reused (re-creating them would error or wipe
   data).
4. **Rebuilds the in-memory dedup state from the DB.** Entities dedupe by
   `entity_id` and articles by title; on resume the loader repopulates its "already
   seen" sets from the DB, so cross-batch dedup stays correct — and re-loading an
   already-present article is an idempotent no-op.
5. **Restarts at the checkpointed `sourceOffset`** against the **deterministic**
   record scan (sorted, stable ordering), re-embedding and loading only the records
   after the last durable checkpoint.

Because each batch is loaded in a **single atomic transaction** and the sidecar is
written only **after** a durable `CHECKPOINT`, a crash mid-batch rolls back cleanly
(no partial rows) and resume re-runs from the last checkpoint. The loader creates
nodes with `CREATE` (not idempotent on its own), so correctness relies on the
all-or-nothing batch boundary plus the article-title dedup skip — not on replaying a
half-committed batch.

## Pipelined build

Within a single run, embedding and loading are decoupled by a small **double
buffer**: while the DB **loads batch _N_** (serial — one writer), the embedder is
already **embedding batch _N+1_** (async, parallel). The loader never waits on a
cold embedder and the embedder never waits on the loader except for backpressure.

```
scan ─▶ [embed N+1]  (parallel, CPU)
             │ handoff
             ▼
        [load  N ]   (serial, single DB writer)  ─▶ commit ─▶ checkpoint
```

- **Bounded memory is preserved.** At most two batches are in flight (the one
  loading and the one embedding), so peak memory is still ~one batch of vectors —
  the streaming property from [docs/cve.md](cve.md) is unchanged.
- **Determinism is preserved.** Batches are still loaded **in order** by the single
  writer; only embedding overlaps. The resulting `pack.db` is byte-for-byte the
  same as a non-pipelined build.
- **Backpressure.** If embedding outruns loading (or vice versa), the pipeline
  stalls the faster stage rather than growing an unbounded queue.

The pipeline needs no configuration — it is always on. `NODE_OPTIONS` sizing (e.g.
`--max-old-space-size`) still applies to the whole process; two in-flight batches
fit comfortably within the documented heap.

## Progress & summary

The builder prints periodic progress (batch index, records/sec, ETA) and, on
completion, the same JSON summary as before (`mapped`, `articles`, `sections`,
`chunks`, `entities`, `relationships`, `seconds`) plus a `resumedFrom` field when
the run continued from a checkpoint.

## Related docs

- [docs/cve.md](cve.md) — the CVE build pipeline, corpus, and mapping.
- [docs/entity-graph.md](entity-graph.md) — scalable `--with-entity-relations` loads.
- [docs/pack-versioning.md](pack-versioning.md) — provenance stamped at build time.
