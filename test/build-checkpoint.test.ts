// test/build-checkpoint.test.ts
//
// TDD (RED): scripts/build-checkpoint.mjs does not exist yet, so this root
// structural suite fails at import today. It encodes the resumable-build contract
// (docs/resumable-build.md): a `<out>.build-checkpoint.json` sidecar that
// round-trips (and is stamped after the batch commit), a params hash that is stable
// for identical inputs but changes with any output-affecting input, and a
// refuse-to-resume check when the recorded params do not match the current run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — plain .mjs helper, no type declarations.
import {
  checkpointPath,
  writeCheckpoint,
  readCheckpoint,
  clearCheckpoint,
  paramsHash,
  checkpointMatches,
  deriveResumeProgress,
  assertExactSourceClosure,
} from '../scripts/build-checkpoint.mjs';

let dir: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'build-ckpt-'));
  out = join(dir, 'pack.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARAMS = {
  src: '/data/cve',
  year: '2025',
  limit: 0,
  batch: 96,
  model: 'Xenova/bge-base-en-v1.5',
  withEntityRelations: false,
};

describe('checkpointPath', () => {
  it('is the <out>.build-checkpoint.json sidecar next to the pack', () => {
    expect(checkpointPath(out)).toBe(`${out}.build-checkpoint.json`);
  });
});

describe('writeCheckpoint / readCheckpoint', () => {
  it('returns null when no checkpoint exists', async () => {
    expect(await readCheckpoint(out)).toBeNull();
  });

  it('round-trips a checkpoint and stamps a parseable updatedAt', async () => {
    const state = {
      batchIndex: 1284,
      sourceOffset: 123264,
      counts: { articles: 123264, sections: 123264, chunks: 501120, entities: 158904 },
      paramsHash: paramsHash(PARAMS),
    };
    await writeCheckpoint(out, state);
    expect(existsSync(checkpointPath(out))).toBe(true);

    const read = await readCheckpoint(out);
    expect(read).toMatchObject(state);
    expect(typeof read.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(read.updatedAt))).toBe(false);

    // Persisted as JSON on disk (not an opaque blob).
    const onDisk = JSON.parse(readFileSync(checkpointPath(out), 'utf8'));
    expect(onDisk.batchIndex).toBe(1284);
  });
});

describe('clearCheckpoint', () => {
  it('removes the sidecar on a clean finish and is a no-op when absent', async () => {
    await writeCheckpoint(out, { batchIndex: 0, sourceOffset: 0, counts: {}, paramsHash: 'x' });
    await clearCheckpoint(out);
    expect(existsSync(checkpointPath(out))).toBe(false);
    await expect(clearCheckpoint(out)).resolves.toBeUndefined();
  });
});

describe('paramsHash / checkpointMatches', () => {
  it('is stable for identical params regardless of key order', () => {
    const reordered = {
      withEntityRelations: false,
      batch: 96,
      model: 'Xenova/bge-base-en-v1.5',
      limit: 0,
      year: '2025',
      src: '/data/cve',
    };
    expect(paramsHash(reordered)).toBe(paramsHash(PARAMS));
  });

  describe('database-authoritative resume progress', () => {
    const inventory = [
      { sourceOffset: 1, title: 'CVE-2025-0001', hash: 'a' },
      { sourceOffset: 3, title: 'CVE-2025-0002', hash: 'b' },
      { sourceOffset: 4, title: 'CVE-2025-0003', hash: 'c' },
    ];

    it('derives progress from durable sources instead of sidecar fields', () => {
      expect(
        deriveResumeProgress(inventory, [
          { title: 'CVE-2025-0002', hash: 'b' },
          { title: 'CVE-2025-0001', hash: 'a' },
        ]),
      ).toEqual({ loadedRecords: 2, sourceOffset: 3 });
    });

    it('rejects forward, non-prefix, and hash-tampered durable progress', () => {
      expect(() =>
        deriveResumeProgress(inventory, [
          { title: 'CVE-2025-0001', hash: 'a' },
          { title: 'CVE-2025-0003', hash: 'c' },
        ]),
      ).toThrow(/exact prefix/i);
      expect(() =>
        deriveResumeProgress(inventory, [{ title: 'CVE-2025-0001', hash: 'tampered' }]),
      ).toThrow(/exact prefix/i);
      expect(() =>
        deriveResumeProgress(inventory, [...inventory, { title: 'extra', hash: 'd' }]),
      ).toThrow(/more sources/i);
    });

    it('requires exact source closure before publication', () => {
      expect(() => assertExactSourceClosure(inventory, inventory)).not.toThrow();
      expect(() => assertExactSourceClosure(inventory, inventory.slice(0, 2))).toThrow(
        /source closure/i,
      );
    });

    it('derives large resume prefixes without sorting or mutating either input', () => {
      const largeInventory = Array.from({ length: 20_000 }, (_, index) => ({
        sourceOffset: index * 2 + 1,
        title: `CVE-2025-${String(index).padStart(5, '0')}`,
        hash: `hash-${index}`,
      }));
      const durable = largeInventory
        .slice(0, 15_000)
        .map(({ title, hash }) => ({ title, hash }))
        .reverse();
      const firstDurable = durable[0];

      expect(deriveResumeProgress(largeInventory, durable)).toEqual({
        loadedRecords: 15_000,
        sourceOffset: 29_999,
      });
      expect(durable[0]).toBe(firstDurable);
    });
  });

  it('changes when any output-affecting input changes', () => {
    const base = paramsHash(PARAMS);
    expect(paramsHash({ ...PARAMS, year: '2024' })).not.toBe(base);
    expect(paramsHash({ ...PARAMS, batch: 128 })).not.toBe(base);
    expect(paramsHash({ ...PARAMS, withEntityRelations: true })).not.toBe(base);
  });

  it('accepts a matching checkpoint and refuses a mismatched one', () => {
    const cp = { paramsHash: paramsHash(PARAMS) };
    expect(checkpointMatches(cp, PARAMS)).toBe(true);
    expect(checkpointMatches(cp, { ...PARAMS, limit: 100 })).toBe(false);
  });
});
