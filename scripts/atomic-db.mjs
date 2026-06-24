// Atomic pack-DB build helpers.
//
// Builders write a LadybugDB and only create the vector/FTS indexes at the very
// end. Writing straight to the destination means an interrupted build leaves a
// partial, unindexed pack at the dest — and a re-run then fails, because the
// schema's `CREATE NODE TABLE` is not idempotent against an existing DB. So we
// build into a temp path on the SAME directory (so the final move is an atomic
// rename, not a cross-filesystem copy) and only swap it into place once the
// build has fully finished. This mirrors the installer's staging + atomic-rename
// pattern (packages/packs/src/installer.ts).
import { randomBytes } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';

// LadybugDB leaves a single DB file after a clean close (verified — no sidecar
// remains), but a `.wal` can exist mid-build; clean those defensively too.
// `rm(..., { recursive: true })` also covers a directory-form DB if a future
// storage version uses one.
function artifacts(path) {
  return [path, `${path}.wal`, `${path}.tmp`];
}

/** A temp build path next to `finalPath` (same dir ⇒ the commit rename is atomic). */
export function tempDbPath(finalPath) {
  return `${finalPath}.building-${randomBytes(6).toString('hex')}`;
}

/** Remove a temp build artifact (and any sidecars). Never throws. */
export async function cleanupDb(tempPath) {
  await Promise.all(artifacts(tempPath).map((p) => rm(p, { force: true, recursive: true })));
}

/** Atomically replace `finalPath` with the completed `tempPath` build. */
export async function commitDb(tempPath, finalPath) {
  // Clear any prior pack (and stale sidecars) so the rename lands on a clean name.
  await Promise.all(artifacts(finalPath).map((p) => rm(p, { force: true, recursive: true })));
  await rename(tempPath, finalPath);
}
