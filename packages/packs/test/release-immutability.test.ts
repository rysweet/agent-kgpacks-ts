import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const releaseScript = join(repoRoot, 'scripts', 'release-pack.mjs');

describe('immutable pack release artifacts', () => {
  let temp: string;
  let packsDir: string;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'kgpacks-release-immutable-'));
    packsDir = join(temp, 'packs');
    const packDir = join(packsDir, 'cve');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      `${JSON.stringify({ name: 'cve', version: '2026.7.0' }, null, 2)}\n`,
    );
    writeFileSync(join(packDir, 'pack.db'), randomBytes(4096));
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('produces byte-identical multipart artifacts for identical inputs', () => {
    const first = join(temp, 'first');
    const second = join(temp, 'second');
    for (const output of [first, second]) {
      execFileSync(
        'node',
        [
          releaseScript,
          '--pack',
          'cve',
          '--packs-dir',
          packsDir,
          '--tag',
          'cve-2026.07',
          '--out-dir',
          output,
          '--part-size',
          '1024B',
          '--dry-run',
        ],
        { stdio: 'ignore' },
      );
    }
    const firstIndex = JSON.parse(readFileSync(join(first, 'cve.pack-release.json'), 'utf8'));
    const secondIndex = JSON.parse(readFileSync(join(second, 'cve.pack-release.json'), 'utf8'));
    expect(secondIndex).toEqual(firstIndex);
    for (const part of firstIndex.parts as Array<{ file: string }>) {
      expect(readFileSync(join(second, part.file))).toEqual(readFileSync(join(first, part.file)));
    }
  });

  it('rejects a dated tag whose derived version differs from the manifest', () => {
    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--tag',
        'cve-2026.08',
        '--out-dir',
        join(temp, 'mismatch'),
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/implies version 2026\.8\.0.*manifest declares 2026\.7\.0/s);
  });

  it('never uses clobber publication', () => {
    expect(readFileSync(releaseScript, 'utf8')).not.toContain("'--clobber'");
  });

  it('aborts packaging when tar exits unsuccessfully', () => {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const fakeTar = join(bin, 'tar');
    writeFileSync(fakeTar, '#!/bin/sh\nprintf partial\nexit 42\n');
    chmodSync(fakeTar, 0o755);

    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        join(temp, 'tar-failure'),
        '--dry-run',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/tar failed.*exit 42/i);
  });

  it('preserves the legacy release path while adding schema-v2 validation', () => {
    expect(readFileSync(releaseScript, 'utf8')).not.toContain(
      'refusing to publish a pack without comprehensive schema-v2 validation',
    );
  });

  it('derives the default immutable tag from the manifest version', () => {
    expect(readFileSync(releaseScript, 'utf8')).toContain(
      'const tag = requestedTag ?? manifestTag',
    );
  });

  it('rejects an explicit versioned tag that disagrees with the manifest', () => {
    const result = spawnSync(
      'node',
      [releaseScript, '--pack', 'cve', '--packs-dir', packsDir, '--tag', 'cve-v1.0.0', '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/must equal the manifest-derived tag cve-v2026\.7\.0/i);
  });

  it('rejects a matching dated suffix for a different pack name', () => {
    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--tag',
        'other-pack-2026.07',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/must equal the manifest-derived tag/i);
  });
});
