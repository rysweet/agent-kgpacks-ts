// packages/packs/test/multipart-release.accounting.test.ts
//
// GUARD (green today; locks the >2 GiB path against silent drift). Exercises the
// multi-part release + streaming-install accounting cheaply by forcing a genuine
// multi-part split with a TINY --part-size over a small synthetic pack — the exact
// technique docs/ci-perf-guards.md prescribes for guarding the >2 GiB path in
// milliseconds. It drives the REAL scripts/release-pack.mjs (via --dry-run) so the
// release index format can never drift from what `wikigr pack pull` re-verifies,
// and asserts the size accounting: every non-final part is exactly one part-size,
// the parts sum to totalBytes, and the overall sha256 equals the hash of the
// concatenated parts (with each per-part sha256 matching its bytes).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildValidCvePack } from '../../../test/helpers/valid-cve-pack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const releaseScript = join(repoRoot, 'scripts', 'release-pack.mjs');
const PACK = 'syn';
const PART_SIZE = 1024;

interface Part {
  file: string;
  bytes: number;
  sha256: string;
}
interface ReleaseIndex {
  name: string;
  format: string;
  sha256: string;
  totalBytes: number;
  partSize: number;
  parts: Part[];
}

let fixtures: string;
let releaseDir: string;
let index: ReleaseIndex;

beforeAll(async () => {
  fixtures = mkdtempSync(join(tmpdir(), 'kgpacks-accounting-'));
  const packsDir = join(fixtures, 'packs');
  const packDir = join(packsDir, PACK);
  await buildValidCvePack(packDir, PACK, '1.0.0');

  releaseDir = join(fixtures, 'release');
  mkdirSync(releaseDir, { recursive: true });
  execFileSync(
    'node',
    [
      releaseScript,
      '--pack',
      PACK,
      '--packs-dir',
      packsDir,
      '--out-dir',
      releaseDir,
      '--part-size',
      `${PART_SIZE}B`,
      '--dry-run',
    ],
    { stdio: 'ignore' },
  );
  index = JSON.parse(readFileSync(join(releaseDir, `${PACK}.pack-release.json`), 'utf8'));
}, 60_000);

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('multi-part release size accounting', () => {
  it('forces a genuine multi-part split (> 1 part) at the requested part-size', () => {
    expect(index.name).toBe(PACK);
    expect(index.format).toBe('tar.gz-multipart-v1');
    expect(index.parts.length).toBeGreaterThan(1);
    expect(index.partSize).toBe(PART_SIZE);
  });

  it('fills every non-final part to exactly one part-size and the last within it', () => {
    for (let i = 0; i < index.parts.length - 1; i++) {
      expect(index.parts[i].bytes).toBe(PART_SIZE);
    }
    const last = index.parts[index.parts.length - 1];
    expect(last.bytes).toBeGreaterThan(0);
    expect(last.bytes).toBeLessThanOrEqual(PART_SIZE);
  });

  it('accounts for every byte: sum(parts.bytes) === totalBytes', () => {
    const sum = index.parts.reduce((n, p) => n + p.bytes, 0);
    expect(sum).toBe(index.totalBytes);
  });

  it('overall sha256 equals the hash of the concatenated parts (per-part shas match)', () => {
    const overall = createHash('sha256');
    for (const part of index.parts) {
      const buf = readFileSync(join(releaseDir, part.file));
      expect(buf.length).toBe(part.bytes);
      expect(createHash('sha256').update(buf).digest('hex')).toBe(part.sha256);
      overall.update(buf);
    }
    expect(overall.digest('hex')).toBe(index.sha256);
  });
});
