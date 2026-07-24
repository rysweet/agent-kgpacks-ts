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

/** Verifies that durable database sources are exactly a prefix of the source inventory. */
export function deriveResumeProgress(inventory, durableSources) {
  if (durableSources.length > inventory.length) {
    throw new Error('durable database contains more sources than the current source inventory');
  }

  const durableByTitle = new Map();
  for (const source of durableSources) {
    if (durableByTitle.has(source.title)) {
      throw new Error(`durable database contains duplicate source ${source.title}`);
    }
    durableByTitle.set(source.title, source.hash);
  }

  const inventoryTitles = new Set();
  for (let index = 0; index < inventory.length; index++) {
    const source = inventory[index];
    if (inventoryTitles.has(source.title)) {
      throw new Error(`source inventory contains duplicate source ${source.title}`);
    }
    inventoryTitles.add(source.title);
    if (index < durableSources.length && durableByTitle.get(source.title) !== source.hash) {
      throw new Error('durable database sources are not an exact prefix of the source inventory');
    }
  }

  return {
    loadedRecords: durableSources.length,
    sourceOffset:
      durableSources.length === 0 ? 0 : inventory[durableSources.length - 1].sourceOffset,
  };
}

/** Verifies exact title/hash closure before a completed database can be published. */
export function assertExactSourceClosure(inventory, durableSources) {
  const progress = deriveResumeProgress(inventory, durableSources);
  if (progress.loadedRecords !== inventory.length) {
    throw new Error('completed database source closure does not match the source inventory');
  }
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
