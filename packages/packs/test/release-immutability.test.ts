import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildValidCvePack } from '../../../test/helpers/valid-cve-pack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const releaseScript = join(repoRoot, 'scripts', 'release-pack.mjs');

describe('immutable pack release artifacts', () => {
  let templateRoot: string;
  let templatePack: string;
  let temp: string;
  let packsDir: string;

  beforeAll(async () => {
    templateRoot = mkdtempSync(join(tmpdir(), 'kgpacks-release-template-'));
    templatePack = join(templateRoot, 'cve');
    await buildValidCvePack(templatePack, 'cve', '2026.7.0');
  }, 60_000);

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'kgpacks-release-immutable-'));
    packsDir = join(temp, 'packs');
    const packDir = join(packsDir, 'cve');
    cpSync(templatePack, packDir, { recursive: true });
  });

  afterAll(() => rmSync(templateRoot, { recursive: true, force: true }));
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

  it('falls back to structural packaging for legacy packs and rejects unknown schemas', () => {
    const manifestPath = join(packsDir, 'cve', 'manifest.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: 'cve', version: '1.2.3', schemaVersion: '1' }, null, 2)}\n`,
    );
    const legacyOut = join(temp, 'legacy');
    const legacy = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        legacyOut,
        '--corpus-commit',
        '0123456789abcdef0123456789abcdef01234567',
        '--corpus-date',
        '2026-07-03',
        '--corpus-tag',
        'cve_2026-07-03_0000Z',
        '--model',
        'legacy-embedding-model',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(legacy.status, legacy.stderr).toBe(0);
    const legacyIndex = JSON.parse(readFileSync(join(legacyOut, 'cve.pack-release.json'), 'utf8'));
    expect(legacyIndex).toMatchObject({
      version: '1.2.3',
      provenance: {
        corpus: {
          commit: '0123456789abcdef0123456789abcdef01234567',
          date: '2026-07-03',
          tag: 'cve_2026-07-03_0000Z',
        },
        embedding: { model: 'legacy-embedding-model' },
      },
    });

    for (const [label, schemaVersion] of [
      ['null', null],
      ['numeric-v2', 2],
      ['unknown-string', '999'],
    ] as const) {
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ name: 'cve', version: '1.2.3', schemaVersion }, null, 2)}\n`,
      );
      const outDir = join(temp, `unsupported-${label}`);
      const unknown = spawnSync(
        'node',
        [releaseScript, '--pack', 'cve', '--packs-dir', packsDir, '--out-dir', outDir, '--dry-run'],
        { encoding: 'utf8' },
      );
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toMatch(/unsupported manifest schema/i);
      expect(existsSync(outDir)).toBe(false);
    }
  });

  it('fills only missing legacy provenance and model fields from release flags', () => {
    const manifestPath = join(packsDir, 'cve', 'manifest.json');
    for (const [label, schemaVersion] of [
      ['absent', undefined],
      ['v1', '1'],
    ] as const) {
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            name: 'cve',
            version: '1.2.3',
            ...(schemaVersion === undefined ? {} : { schemaVersion }),
            model: 'manifest-top-level-model',
            synthesis_model: 'manifest-synthesis-model',
            provenance: {
              corpus: { commit: 'manifest-commit', tag: 'manifest-tag' },
              embedding: { model: 'manifest-embedding-model' },
            },
          },
          null,
          2,
        )}\n`,
      );
      const outDir = join(temp, `legacy-preserve-${label}`);
      const result = spawnSync(
        'node',
        [
          releaseScript,
          '--pack',
          'cve',
          '--packs-dir',
          packsDir,
          '--out-dir',
          outDir,
          '--corpus-commit',
          'flag-commit',
          '--corpus-date',
          '2026-07-24',
          '--corpus-tag',
          'flag-tag',
          '--model',
          'flag-model',
          '--dry-run',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const index = JSON.parse(readFileSync(join(outDir, 'cve.pack-release.json'), 'utf8'));
      expect(index).toMatchObject({
        model: 'manifest-embedding-model',
        provenance: {
          corpus: {
            commit: 'manifest-commit',
            date: '2026-07-24',
            tag: 'manifest-tag',
          },
          embedding: { model: 'manifest-embedding-model' },
        },
      });
    }
  });

  it('fully validates schema-v2 before evaluating release flag assertions', () => {
    writeFileSync(
      join(packsDir, 'cve', 'manifest.json'),
      `${JSON.stringify({ name: 'cve', version: '1.2.3', schemaVersion: '2' }, null, 2)}\n`,
    );
    const outDir = join(temp, 'invalid-v2-with-flag');
    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        outDir,
        '--corpus-commit',
        'flag-commit',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/must exactly match schema-v2 manifest provenance/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it('accepts schema-v2 release flags only when every value exactly matches the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(packsDir, 'cve', 'manifest.json'), 'utf8'));
    const outDir = join(temp, 'matching-v2-flags');
    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        outDir,
        '--corpus-commit',
        manifest.provenance.corpus.commit,
        '--corpus-date',
        manifest.provenance.corpus.date,
        '--corpus-tag',
        manifest.provenance.corpus.tag,
        '--model',
        manifest.provenance.embedding.model,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const index = JSON.parse(readFileSync(join(outDir, 'cve.pack-release.json'), 'utf8'));
    expect(index.provenance).toEqual(manifest.provenance);
  });

  it.each([
    ['--corpus-commit', 'different-commit'],
    ['--corpus-date', '1900-01-01'],
    ['--corpus-tag', 'different-tag'],
    ['--model', 'different-model'],
  ])('rejects a schema-v2 %s value that differs from the manifest', (flag, value) => {
    const outDir = join(temp, `mismatched-v2-${flag.slice(2)}`);
    const result = spawnSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        outDir,
        flag,
        value,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${flag} must exactly match schema-v2 manifest provenance`);
    expect(existsSync(outDir)).toBe(false);
  });

  it('validates database contents even during a dry run', () => {
    writeFileSync(join(packsDir, 'cve', 'pack.db'), 'tampered');
    const outDir = join(temp, 'invalid');
    const result = spawnSync(
      'node',
      [releaseScript, '--pack', 'cve', '--packs-dir', packsDir, '--out-dir', outDir, '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(() => readFileSync(join(outDir, 'cve.pack-release.json'))).toThrow();
  });

  it('refuses unsigned publication and limits --no-sign to dry runs', () => {
    for (const extra of [[], ['--no-sign']]) {
      const result = spawnSync(
        'node',
        [releaseScript, '--pack', 'cve', '--packs-dir', packsDir, ...extra],
        { encoding: 'utf8', env: { ...process.env, KGPACKS_SIGNING_KEY: undefined } },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(
        extra.length ? /allowed only with --dry-run/i : /requires a signing key/i,
      );
    }
  });

  it('allows explicitly unsigned dry-run artifacts', () => {
    const outDir = join(temp, 'unsigned-dry-run');
    execFileSync(
      'node',
      [
        releaseScript,
        '--pack',
        'cve',
        '--packs-dir',
        packsDir,
        '--out-dir',
        outDir,
        '--no-sign',
        '--dry-run',
      ],
      { stdio: 'ignore' },
    );
    expect(readFileSync(join(outDir, 'cve.pack-release.json'), 'utf8')).toContain('"name": "cve"');
  });

  it('mirrors corpus commit and date exactly into the release index', () => {
    const manifest = JSON.parse(readFileSync(join(packsDir, 'cve', 'manifest.json'), 'utf8'));
    const outDir = join(temp, 'provenance');
    execFileSync(
      'node',
      [releaseScript, '--pack', 'cve', '--packs-dir', packsDir, '--out-dir', outDir, '--dry-run'],
      { stdio: 'ignore' },
    );
    const index = JSON.parse(readFileSync(join(outDir, 'cve.pack-release.json'), 'utf8'));
    expect(index.provenance).toEqual(manifest.provenance);
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
