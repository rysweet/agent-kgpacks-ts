// test/atomic-db.test.ts
//
// Contract for the atomic pack-DB build helpers (scripts/atomic-db.mjs) used by
// build-cve-pack.mjs and build-catalog.mjs. The point of these helpers is that an
// interrupted build never publishes a partial/unindexed pack: work happens in a
// temp file and is only renamed into place once finished.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// @ts-expect-error — plain .mjs helper, no type declarations.
import { tempDbPath, commitDb, cleanupDb } from '../scripts/atomic-db.mjs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tempDbPath', () => {
  it('returns a unique sibling path of the destination (same directory)', () => {
    const dest = join(dir, 'pack.db');
    const a = tempDbPath(dest);
    const b = tempDbPath(dest);
    expect(dirname(a)).toBe(dirname(dest));
    expect(a).not.toBe(dest);
    expect(a).not.toBe(b); // randomized suffix ⇒ no collision between concurrent builds
  });
});

describe('commitDb', () => {
  it('atomically moves the temp build to the destination', async () => {
    const dest = join(dir, 'pack.db');
    const tmp = tempDbPath(dest);
    writeFileSync(tmp, 'BUILT');

    await commitDb(tmp, dest);

    expect(existsSync(tmp)).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('BUILT');
  });

  it('overwrites a prior pack (and its stale .wal sidecar) at the destination', async () => {
    const dest = join(dir, 'pack.db');
    writeFileSync(dest, 'OLD');
    writeFileSync(`${dest}.wal`, 'stale-wal');
    const tmp = tempDbPath(dest);
    writeFileSync(tmp, 'NEW');

    await commitDb(tmp, dest);

    expect(readFileSync(dest, 'utf8')).toBe('NEW');
    expect(existsSync(`${dest}.wal`)).toBe(false);
  });
});

describe('cleanupDb', () => {
  it('removes a temp build artifact and its sidecars without throwing', async () => {
    const dest = join(dir, 'pack.db');
    const tmp = tempDbPath(dest);
    writeFileSync(tmp, 'PARTIAL');
    writeFileSync(`${tmp}.wal`, 'wal');

    await expect(cleanupDb(tmp)).resolves.toBeUndefined();
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(`${tmp}.wal`)).toBe(false);
  });

  it('is a no-op (does not throw) when nothing exists', async () => {
    await expect(cleanupDb(join(dir, 'never-created.db'))).resolves.toBeUndefined();
  });
});
