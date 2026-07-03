# CI coverage & performance guards

Two properties of the pack pipeline are easy to break silently and expensive to
discover in production: the **>2 GiB multi-part release + streaming-install** path,
and the **~linear** streaming pack load fixed in PR #69. Both are now guarded in CI
by fast, deterministic tests that never require the real 4.8 GiB pack.

## The multi-part install end-to-end test

**What it guards:** that a pack published as **multiple parts** (because it exceeds
GitHub's 2 GiB per-asset limit) round-trips correctly through
`scripts/release-pack.mjs` → `<name>.pack-release.json` index → `wikigr pack pull`
→ streaming install — including per-part and overall checksum verification and the
bounded-memory streamed reassembly.

**How it stays cheap:** instead of producing multi-gigabyte assets, the test forces
a **multi-part** release from a tiny synthetic pack by setting a **tiny
`--part-size`**. A few kilobytes of incompressible pack split at `--part-size
1024B` yields several real parts, exercising the exact split/concat/verify code
paths that a 2 GiB pack would, in milliseconds. It drives the **real**
`scripts/release-pack.mjs` (via `--dry-run`) so the on-disk release-index format
can never drift from what `wikigr pack pull` re-verifies.

```bash
# What the CI test does, in miniature (it builds the pack + index inline):
#   packDir/manifest.json + packDir/pack.db (8 KiB of random, incompressible bytes)
node scripts/release-pack.mjs --pack syn --packs-dir <packs> --part-size 1024B \
  --dry-run --out-dir <rel>
ls <rel>
#   syn.tar.gz.000  syn.tar.gz.001  …  syn.pack-release.json
```

The suite then asserts the **size accounting** on the produced index:

- a genuine multi-part split (`parts.length > 1`) at the requested `partSize`;
- every **non-final** part is exactly one `partSize`, and the last is within it;
- `sum(parts.bytes) === totalBytes` (every byte accounted for);
- each part's `sha256` matches its bytes, and the overall `sha256` equals the hash
  of the **concatenated** parts.

Because it drives the real release script, the index format is locked to what the
puller consumes. This complements the localhost **round-trip** in
`packages/cli/test/pack-pull.test.ts` (which serves the parts over HTTP and
asserts a byte-identical multi-part streaming install), and the streaming
installer's own **uncompressed-size cap** (`STREAM_MAX_TOTAL_BYTES`) is unit-tested
in isolation by `packages/packs/test/installer-stream.test.ts` — injecting a tiny
`maxTotalBytes` proves the >2 GiB accounting rejects an over-limit archive at any
scale, with no large I/O. The multi-part accounting guard lives at
`packages/packs/test/multipart-release.accounting.test.ts`.

## The linear-scaling guard

**What it guards:** the streaming loader's edge creation stays **~linear** in the
number of records, protecting against a regression to the **O(N²) comma two-pattern
`MATCH`** that PR #69 replaced with PK-indexed single-`MATCH` `UNWIND`.

Wall-clock timing is flaky in CI, so the guard is **structural, not temporal** —
two deterministic assertions:

1. **Statement-count linearity.** A spy `Connection` records every Cypher statement
   the loader issues. Loading `N` records then `2N` records must issue a statement
   count that grows **~linearly** (within a small constant factor), not
   quadratically. The test asserts `statements(2N) ≤ k · statements(N)` for a tight
   `k`, catching any per-record fan-out that scales with prior batches.

2. **No comma two-pattern `MATCH`.** Every edge-creation statement is matched
   against a regex that **rejects** the regressing pattern — a single `MATCH` with
   two comma-separated node patterns over the growing node tables, e.g.
   `MATCH (a:Article {…}), (e:Entity {…})`. Edge creation must use the
   PK-indexed shape (`UNWIND … MATCH (a) MATCH (e) CREATE …` or a bulk `COPY`),
   never the comma join.

```ts
// packages/ingestion/test/streaming-loader.linear-scaling.test.ts (shape)
// A Proxy over a real Connection records every Cypher statement `run` is asked.
const { conn, statements } = recordingConnection(new Database().connect());
const writer = await createPackWriter(conn, { insertChunkSize: 1000 });
for (let i = 0; i < N; i++) await writer.addBatch([record(i)]);
await writer.finalize(links);
const s1 = statements.length; // then repeat for 2N with a fresh DB → s2

expect(s2).toBeLessThanOrEqual(LINEAR_FACTOR * s1); // ~linear, not O(N²)
const edgeStatements = statements.filter((s) => s.includes('->') && s.includes('CREATE'));
for (const cypher of edgeStatements) {
  expect(cypher).not.toMatch(COMMA_TWO_PATTERN_MATCH_RE); // PR #69 regression
}
```

Because both checks are deterministic (counts + a regex, no timers), the guard is
**non-flaky** and fails loudly the moment edge creation stops being linear.

## Where these run in CI

Both tests are ordinary Vitest suites, so they run in the existing **`build`** job's
`pnpm -r test` step (see [docs/monorepo.md](monorepo.md#continuous-integration)) —
no new job, no new tooling, no Python, and no large downloads. They obey the same
gates as the rest of the suite: pinned deps, `--frozen-lockfile`, and a green
`pnpm audit`.

## Related docs

- [docs/monorepo.md](monorepo.md#continuous-integration) — the CI pipeline.
- [docs/cve.md](cve.md) — the streaming pack build & the O(N²)→linear edge load.
- [docs/packages/packs.md](packages/packs.md) — the installer & release-index security model.
