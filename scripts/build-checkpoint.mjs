// Resumable-build checkpoint sidecar helpers.
//
// A build writes a `<out>.build-checkpoint.json` sidecar next to the output pack
// recording exactly what has been DURABLY loaded (last committed batch index, the
// position in the deterministic record scan, running counts, and a hash of the
// output-affecting build parameters). On restart the builder resumes from the last
// committed batch when the params hash matches, else refuses and asks for a clean
// rebuild. See docs/resumable-build.md.
//
// Pure and dependency-free (Node built-ins only), so it is unit-tested in isolation
// by test/build-checkpoint.test.ts.

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';

const CHECKPOINT_VERSION = 1;

/** The sidecar path for a given output pack path. */
export function checkpointPath(out) {
  return `${out}.build-checkpoint.json`;
}

/** Recursively key-sorts an object so serialization is order-independent. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = canonicalize(value[key]);
        return out;
      }, {});
  }
  return value;
}

/**
 * Stable SHA-256 of the output-affecting build params. Independent of key order,
 * but changes when ANY output-affecting input changes (src, year, limit, batch,
 * model, withEntityRelations, …).
 */
export function paramsHash(params) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(params)))
    .digest('hex');
}

/** True when a checkpoint's recorded params hash matches the current params. */
export function checkpointMatches(checkpoint, params) {
  return Boolean(checkpoint) && checkpoint.paramsHash === paramsHash(params);
}

/**
 * Writes the checkpoint sidecar (stamped with a version + `updatedAt`). Call this
 * AFTER the batch's DB transaction has durably committed, so it never claims more
 * progress than the database holds.
 */
export async function writeCheckpoint(out, state) {
  const record = { version: CHECKPOINT_VERSION, ...state, updatedAt: new Date().toISOString() };
  await writeFile(checkpointPath(out), `${JSON.stringify(record, null, 2)}\n`);
}

/** Reads the checkpoint sidecar, or returns null when none exists. */
export async function readCheckpoint(out) {
  let raw;
  try {
    raw = await readFile(checkpointPath(out), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/** Removes the checkpoint sidecar. A no-op when it is already absent. */
export async function clearCheckpoint(out) {
  await rm(checkpointPath(out), { force: true });
}
