// packages/packs/test/installer.test.ts
//
// Contract + ADVERSARIAL security tests for the installer documented in
// docs/packages/packs.md (Installer API + Security model). The installer extracts
// a local `.tar.gz` with full security parity: every entry is validated BEFORE
// any byte is written, and traversal / absolute / symlink (and other link/device)
// entries are rejected outright.
//
// Archive fixtures — benign and malicious — are built in-test by the tiny ustar
// writer in ./helpers/tar.ts, so the malicious cases are fully reviewable here and
// there are no committed binaries. Each security negative asserts BOTH that the
// call throws AND that no escaping/sibling path was ever created on disk.
//
// TDD: these FAIL today because packages/packs/src does not yet export the
// installer surface. They PASS once installer.ts lands.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installPack, ManifestValidationError, PackInstallError } from '../src/index.js';
import type { TarEntryInput } from './helpers/tar.js';
import { makeTarGz } from './helpers/tar.js';

const PACK_NAME = 'world-history';

const packManifest = (name = PACK_NAME): Record<string, unknown> => ({
  name,
  version: '1.2.0',
  description: 'World history knowledge pack',
  graph_stats: { node_count: 10, edge_count: 20 },
  eval_scores: { recall_at_5: 0.8 },
});

const benignEntries = (name = PACK_NAME): TarEntryInput[] => [
  { name: 'manifest.json', content: JSON.stringify(packManifest(name), null, 2) + '\n' },
  { name: 'data/', type: 'dir' },
  { name: 'data/graph.txt', content: 'hello-graph' },
];

let base: string;
let installRoot: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-packs-installer-'));
  installRoot = join(base, 'install');
  outside = join(base, 'outside');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeArchive(entries: TarEntryInput[]): string {
  const archivePath = join(base, 'pack.tar.gz');
  writeFileSync(archivePath, makeTarGz(entries));
  return archivePath;
}

describe('@kgpacks/packs — installPack (benign extraction)', () => {
  it('extracts a valid pack into installRoot/<name> with the correct layout', () => {
    const archive = writeArchive(benignEntries());
    const result = installPack(archive, installRoot);

    expect(result.name).toBe(PACK_NAME);
    expect(result.version).toBe('1.2.0');
    expect(result.path).toBe(join(installRoot, PACK_NAME));
    expect(result.manifest).toEqual(packManifest());

    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true);
    expect(readFileSync(join(result.path, 'data', 'graph.txt'), 'utf8')).toBe('hello-graph');
  });

  it('refuses to overwrite an already-installed pack of the same name', () => {
    const archive = writeArchive(benignEntries());
    installPack(archive, installRoot);
    expect(() => installPack(archive, installRoot)).toThrow(PackInstallError);
    // The first install survives untouched.
    expect(readFileSync(join(installRoot, PACK_NAME, 'data', 'graph.txt'), 'utf8')).toBe(
      'hello-graph',
    );
  });
});

describe('@kgpacks/packs — installPack (security negatives)', () => {
  it('rejects a path-traversal (../) entry and writes nothing outside the target', () => {
    const escaped = join(base, 'evil.txt'); // resolve('../evil.txt') from installRoot
    const archive = writeArchive([
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: '../evil.txt', content: 'pwned' },
    ]);

    expect(() => installPack(archive, installRoot)).toThrow(PackInstallError);
    expect(existsSync(escaped)).toBe(false);
    // The whole install aborts — not even the benign manifest lands.
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });

  it('rejects an absolute-path entry and never writes to the absolute location', () => {
    const absoluteTarget = join(outside, 'escape.txt'); // absolute, begins with '/'
    const archive = writeArchive([
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: absoluteTarget, content: 'pwned' },
    ]);

    expect(() => installPack(archive, installRoot)).toThrow(PackInstallError);
    expect(existsSync(absoluteTarget)).toBe(false);
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });

  it('rejects a symlink entry and never materializes the link', () => {
    const archive = writeArchive([
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: 'link', type: 'symlink', linkname: '/etc/passwd' },
    ]);

    expect(() => installPack(archive, installRoot)).toThrow(PackInstallError);
    expect(existsSync(join(installRoot, 'link'))).toBe(false);
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });

  it.each<['hardlink' | 'char' | 'block' | 'fifo']>([['hardlink'], ['char'], ['block'], ['fifo']])(
    'rejects a %s entry (only files and directories are allowed)',
    (type) => {
      const archive = writeArchive([
        { name: 'manifest.json', content: JSON.stringify(packManifest()) },
        { name: 'special', type, linkname: type === 'hardlink' ? 'manifest.json' : undefined },
      ]);
      expect(() => installPack(archive, installRoot)).toThrow(PackInstallError);
      expect(existsSync(join(installRoot, 'special'))).toBe(false);
    },
  );
});

describe('@kgpacks/packs — installPack (archive + manifest faults)', () => {
  it('throws PackInstallError when the archive is not a valid gzip/tar stream', () => {
    const corrupt = join(base, 'corrupt.tar.gz');
    writeFileSync(corrupt, Buffer.from('this is not a gzip stream'));
    expect(() => installPack(corrupt, installRoot)).toThrow(PackInstallError);
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });

  it('throws ManifestValidationError when the archive has no manifest.json', () => {
    const archive = writeArchive([{ name: 'data/graph.txt', content: 'x' }]);
    expect(() => installPack(archive, installRoot)).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError when the embedded manifest is schema-invalid', () => {
    const archive = writeArchive([
      { name: 'manifest.json', content: JSON.stringify({ name: '../bad', version: '1.0.0' }) },
    ]);
    expect(() => installPack(archive, installRoot)).toThrow(ManifestValidationError);
    // A discarded staging dir leaves nothing installed.
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });
});
