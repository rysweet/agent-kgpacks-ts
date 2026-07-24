// packages/cli/test/pack-pull.test.ts
//
// End-to-end test for `pack pull` against artifacts produced by the REAL release
// script (scripts/release-pack.mjs, --dry-run) and the REAL streaming installer —
// no mocks for the archive format, so the pull path can never silently drift from
// what the release script emits. A tiny --part-size forces a genuine multi-part
// archive; a localhost server stands in for the GitHub release host.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PackInstallError } from '@kgpacks/packs';
import { buildValidCvePack } from '../../../test/helpers/valid-cve-pack.js';

import { pullPack } from '../src/pack-pull.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const releaseScript = join(repoRoot, 'scripts', 'release-pack.mjs');
const PACK_NAME = 'world-history';
interface MutablePayloadManifest {
  version: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}
let dbBytes: Buffer;

let base: string;
let releaseDir: string;
let server: Server;
let baseUrl: string;

// Build the release artifacts ONCE with the real script, then serve them.
beforeAll(async () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'kgpacks-pull-fixtures-'));
  const packsDir = join(fixtures, 'packs');
  const packDir = join(packsDir, PACK_NAME);
  await buildValidCvePack(packDir, PACK_NAME, '1.2.0');
  dbBytes = readFileSync(join(packDir, 'pack.db'));

  releaseDir = join(fixtures, 'release');
  mkdirSync(releaseDir, { recursive: true });
  execFileSync(
    'node',
    [
      releaseScript,
      '--pack',
      PACK_NAME,
      '--packs-dir',
      packsDir,
      '--out-dir',
      releaseDir,
      '--part-size',
      '1024B',
      '--dry-run',
    ],
    { stdio: 'ignore' },
  );

  server = createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      res.statusCode = 400;
      res.end('bad');
      return;
    }
    try {
      const stream = createReadStream(join(releaseDir, name));
      stream.on('error', () => {
        res.statusCode = 404;
        res.end('not found');
      });
      stream.pipe(res);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-pull-install-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('pack pull (real release artifacts → real streaming install)', () => {
  it('produced a genuine multi-part release (more than one part)', () => {
    const index = JSON.parse(
      readFileSync(join(releaseDir, `${PACK_NAME}.pack-release.json`), 'utf8'),
    );
    expect(index.name).toBe(PACK_NAME);
    expect(Array.isArray(index.parts)).toBe(true);
    expect(index.parts.length).toBeGreaterThan(1);
  });

  it('downloads, verifies, and installs the pack', async () => {
    const installRoot = join(base, 'install');
    const result = await pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl });

    expect(result.name).toBe(PACK_NAME);
    expect(result.version).toBe('1.2.0');
    expect(result.parts).toBeGreaterThan(1);
    expect(readFileSync(join(result.path, 'pack.db')).equals(dbBytes)).toBe(true);
    expect(JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8')).name).toBe(
      PACK_NAME,
    );
  });

  it('rejects a tampered part (checksum mismatch) and installs nothing', async () => {
    const tampered = mkdtempSync(join(tmpdir(), 'kgpacks-pull-tamper-'));
    const index = JSON.parse(
      readFileSync(join(releaseDir, `${PACK_NAME}.pack-release.json`), 'utf8'),
    );
    // Copy the index + parts, then corrupt the first part's bytes.
    writeFileSync(join(tampered, `${PACK_NAME}.pack-release.json`), JSON.stringify(index));
    for (const part of index.parts) {
      const buf = readFileSync(join(releaseDir, part.file));
      writeFileSync(join(tampered, part.file), buf);
    }
    const firstPart = join(tampered, index.parts[0].file);
    const corrupt = readFileSync(firstPart);
    corrupt[0] = corrupt[0] ^ 0xff;
    writeFileSync(firstPart, corrupt);

    const tamperServer = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
      createReadStream(join(tampered, name))
        .on('error', () => {
          res.statusCode = 404;
          res.end();
        })
        .pipe(res);
    });
    await new Promise<void>((resolve) => tamperServer.listen(0, '127.0.0.1', resolve));
    const addr = tamperServer.address();
    const tamperUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
    const installRoot = join(base, 'install-tamper');
    try {
      await expect(
        pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl: tamperUrl }),
      ).rejects.toBeInstanceOf(PackInstallError);
    } finally {
      tamperServer.close();
      rmSync(tampered, { recursive: true, force: true });
    }
  });

  it('rejects duplicate part filenames before downloading or installing', async () => {
    const duplicate = mkdtempSync(join(tmpdir(), 'kgpacks-pull-duplicate-'));
    const index = JSON.parse(
      readFileSync(join(releaseDir, `${PACK_NAME}.pack-release.json`), 'utf8'),
    );
    index.parts = [index.parts[0], index.parts[0]];
    writeFileSync(join(duplicate, `${PACK_NAME}.pack-release.json`), JSON.stringify(index));
    const requested: string[] = [];
    const duplicateServer = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
      requested.push(name);
      createReadStream(join(duplicate, name))
        .on('error', () => {
          res.statusCode = 404;
          res.end();
        })
        .pipe(res);
    });
    await new Promise<void>((resolve) => duplicateServer.listen(0, '127.0.0.1', resolve));
    const addr = duplicateServer.address();
    const duplicateUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
    const installRoot = join(base, 'install-duplicate');
    try {
      await expect(
        pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl: duplicateUrl }),
      ).rejects.toThrow(/duplicate part filename/i);
      expect(requested).not.toContain(index.parts[0].file);
      expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
    } finally {
      duplicateServer.close();
      rmSync(duplicate, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'checksum',
      (bytes: Buffer) => {
        bytes[0] ^= 0xff;
        return bytes;
      },
      /checksum mismatch/,
    ],
    ['size', (bytes: Buffer) => bytes.subarray(1), /size mismatch/],
  ])('re-verifies finalized scratch part %s before installing', async (_kind, mutate, expected) => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'kgpacks-pull-scratch-'));
    const index = JSON.parse(
      readFileSync(join(releaseDir, `${PACK_NAME}.pack-release.json`), 'utf8'),
    );
    const firstPart = index.parts[0].file as string;
    const secondPart = index.parts[1].file as string;
    const rereadServer = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
      if (name === secondPart) {
        const [workDir] = readdirSync(tmpRoot);
        const finalized = readFileSync(join(tmpRoot, workDir, firstPart));
        writeFileSync(join(tmpRoot, workDir, firstPart), mutate(finalized));
      }
      createReadStream(join(releaseDir, name))
        .on('error', () => {
          res.statusCode = 404;
          res.end();
        })
        .pipe(res);
    });
    await new Promise<void>((resolve) => rereadServer.listen(0, '127.0.0.1', resolve));
    const addr = rereadServer.address();
    const rereadUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
    const installRoot = join(base, 'install-reread');
    try {
      await expect(
        pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl: rereadUrl, tmpRoot }),
      ).rejects.toThrow(expected);
      expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
    } finally {
      rereadServer.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('re-verifies the finalized archive checksum in declared part order', async () => {
    const invalid = mkdtempSync(join(tmpdir(), 'kgpacks-pull-overall-'));
    const index = JSON.parse(
      readFileSync(join(releaseDir, `${PACK_NAME}.pack-release.json`), 'utf8'),
    );
    index.sha256 = '0'.repeat(64);
    writeFileSync(join(invalid, `${PACK_NAME}.pack-release.json`), JSON.stringify(index));
    for (const part of index.parts) {
      writeFileSync(join(invalid, part.file), readFileSync(join(releaseDir, part.file)));
    }
    const invalidServer = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
      createReadStream(join(invalid, name))
        .on('error', () => {
          res.statusCode = 404;
          res.end();
        })
        .pipe(res);
    });
    await new Promise<void>((resolve) => invalidServer.listen(0, '127.0.0.1', resolve));
    const addr = invalidServer.address();
    const invalidUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
    const installRoot = join(base, 'install-overall');
    try {
      await expect(
        pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl: invalidUrl }),
      ).rejects.toThrow(/overall checksum/i);
      expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
    } finally {
      invalidServer.close();
      rmSync(invalid, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'checksum',
      (manifest: MutablePayloadManifest) => (manifest.files[0].sha256 = '0'.repeat(64)),
      /pack\.db checksum mismatch/i,
    ],
    [
      'size',
      (manifest: MutablePayloadManifest) => manifest.files[0].size++,
      /pack\.db size mismatch/i,
    ],
    [
      'declaration',
      (manifest: MutablePayloadManifest) => (manifest.files = []),
      /must declare exactly pack\.db/i,
    ],
  ])(
    'rejects a schema-v2 pack.db %s mismatch and removes the installed destination',
    async (_kind, mutateManifest, expected) => {
      const invalid = mkdtempSync(join(tmpdir(), 'kgpacks-pull-payload-'));
      const packDir = join(invalid, 'pack');
      mkdirSync(packDir);
      writeFileSync(join(packDir, 'pack.db'), dbBytes);
      const manifest = JSON.parse(
        readFileSync(join(dirname(releaseDir), 'packs', PACK_NAME, 'manifest.json'), 'utf8'),
      ) as MutablePayloadManifest;
      mutateManifest(manifest);
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest));
      const archive = join(invalid, 'archive.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', packDir, 'manifest.json', 'pack.db']);
      const archiveBytes = readFileSync(archive);
      const partFile = `${PACK_NAME}.tar.gz.000`;
      writeFileSync(join(invalid, partFile), archiveBytes);
      const digest = createHash('sha256').update(archiveBytes).digest('hex');
      writeFileSync(
        join(invalid, `${PACK_NAME}.pack-release.json`),
        JSON.stringify({
          name: PACK_NAME,
          version: manifest.version,
          format: 'tar.gz-multipart-v1',
          sha256: digest,
          totalBytes: archiveBytes.length,
          parts: [{ file: partFile, bytes: archiveBytes.length, sha256: digest }],
        }),
      );
      const invalidServer = createServer((req, res) => {
        const name = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
        createReadStream(join(invalid, name))
          .on('error', () => {
            res.statusCode = 404;
            res.end();
          })
          .pipe(res);
      });
      await new Promise<void>((resolve) => invalidServer.listen(0, '127.0.0.1', resolve));
      const addr = invalidServer.address();
      const invalidUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
      const installRoot = join(base, 'install-payload');
      try {
        await expect(
          pullPack({ name: PACK_NAME, packsDir: installRoot, baseUrl: invalidUrl }),
        ).rejects.toThrow(expected);
        expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
      } finally {
        invalidServer.close();
        rmSync(invalid, { recursive: true, force: true });
      }
    },
  );

  it('throws when the pack index is absent', async () => {
    await expect(
      pullPack({ name: 'does-not-exist', packsDir: join(base, 'x'), baseUrl }),
    ).rejects.toBeInstanceOf(PackInstallError);
  });
});
