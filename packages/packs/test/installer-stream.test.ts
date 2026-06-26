// packages/packs/test/installer-stream.test.ts
//
// Contract + ADVERSARIAL tests for the STREAMING installer (installPackFromStream)
// documented in docs/packages/packs.md. The streaming path validates every
// entry's header BEFORE writing any of its bytes — exactly like the buffer path —
// but never holds the whole archive in memory, so it scales to multi-GB packs
// (the full CVE pack is ~6-7 GiB, over GitHub's 2 GiB per-asset limit, hence
// multi-part download + streaming install).
//
// Archive fixtures are built in-test by the same tiny ustar writer used by the
// buffer-installer tests, so every malicious case is fully reviewable here.
// Robustness against arbitrary chunk boundaries (the whole point of streaming) is
// exercised by feeding the gzip bytes one byte at a time and as multiple parts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installPackFromStream, ManifestValidationError, PackInstallError } from '../src/index.js';
import { parseSizeField } from '../src/tar.js';
import type { TarEntryInput } from './helpers/tar.js';
import { makeTarGz } from './helpers/tar.js';

const PACK_NAME = 'world-history';

const packManifest = (name = PACK_NAME): Record<string, unknown> => ({
  name,
  version: '1.2.0',
  description: 'World history knowledge pack',
  graph_stats: { articles: 10, entities: 20, relationships: 15, size_mb: 1.2 },
  eval_scores: { recall_at_5: 0.8 },
});

const benignEntries = (name = PACK_NAME): TarEntryInput[] => [
  { name: 'manifest.json', content: JSON.stringify(packManifest(name), null, 2) + '\n' },
  { name: 'data/', type: 'dir' },
  { name: 'data/graph.txt', content: 'hello-graph' },
  // A multi-block file that forces content to span gunzip-chunk boundaries.
  { name: 'pack.db', content: 'x'.repeat(5000) },
];

let base: string;
let installRoot: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-packs-stream-'));
  installRoot = join(base, 'install');
  outside = join(base, 'outside');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A Readable that emits `buf` in fixed-size slices, modelling streamed/chunked
 *  delivery (and, when sliced, multi-part downloads concatenated back). */
function chunkedStream(buf: Buffer, chunkSize: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= buf.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkSize, buf.length);
      this.push(buf.subarray(offset, end));
      offset = end;
    },
  });
}

describe('@kgpacks/packs — installPackFromStream (benign extraction)', () => {
  it('extracts a valid pack into installRoot/<name> with the correct layout', async () => {
    const result = await installPackFromStream(
      Readable.from(makeTarGz(benignEntries())),
      installRoot,
    );

    expect(result.name).toBe(PACK_NAME);
    expect(result.version).toBe('1.2.0');
    expect(result.path).toBe(join(installRoot, PACK_NAME));
    expect(readFileSync(join(result.path, 'data/graph.txt'), 'utf8')).toBe('hello-graph');
    expect(readFileSync(join(result.path, 'pack.db'), 'utf8')).toBe('x'.repeat(5000));
    expect(existsSync(join(result.path, 'manifest.json'))).toBe(true);
    // No staging directory left behind.
    expect(readFileSync(join(result.path, 'manifest.json'), 'utf8')).toContain(PACK_NAME);
  });

  it('handles arbitrary chunk boundaries (one byte at a time)', async () => {
    const gz = makeTarGz(benignEntries());
    const result = await installPackFromStream(chunkedStream(gz, 1), installRoot);
    expect(result.name).toBe(PACK_NAME);
    expect(readFileSync(join(result.path, 'pack.db'), 'utf8')).toBe('x'.repeat(5000));
  });

  it('installs from a multi-part archive (byte-sliced then re-streamed)', async () => {
    // Models the multi-part release: the .tar.gz is split into N byte ranges,
    // downloaded, and concatenated back into one stream before extraction.
    const gz = makeTarGz(benignEntries());
    const mid = Math.floor(gz.length / 3);
    const parts = [gz.subarray(0, mid), gz.subarray(mid, 2 * mid), gz.subarray(2 * mid)];
    const result = await installPackFromStream(Readable.from(parts), installRoot);
    expect(result.name).toBe(PACK_NAME);
    expect(readFileSync(join(result.path, 'data/graph.txt'), 'utf8')).toBe('hello-graph');
  });

  it('refuses to overwrite an already-installed pack of the same name', async () => {
    await installPackFromStream(Readable.from(makeTarGz(benignEntries())), installRoot);
    await expect(
      installPackFromStream(Readable.from(makeTarGz(benignEntries())), installRoot),
    ).rejects.toBeInstanceOf(PackInstallError);
  });
});

describe('@kgpacks/packs — installPackFromStream (security negatives)', () => {
  it('rejects a path-traversal (../) entry and writes nothing outside the target', async () => {
    const entries: TarEntryInput[] = [
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: '../escape.txt', content: 'pwned' },
    ];
    await expect(
      installPackFromStream(Readable.from(makeTarGz(entries)), installRoot),
    ).rejects.toBeInstanceOf(PackInstallError);
    expect(existsSync(join(installRoot, '..', 'escape.txt'))).toBe(false);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    // Failed install leaves no installed pack (staging is removed).
    expect(existsSync(join(installRoot, PACK_NAME))).toBe(false);
  });

  it('rejects an absolute-path entry and never writes to the absolute location', async () => {
    const abs = join(outside, 'abs-evil.txt');
    const entries: TarEntryInput[] = [
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: abs, content: 'pwned' },
    ];
    await expect(
      installPackFromStream(Readable.from(makeTarGz(entries)), installRoot),
    ).rejects.toBeInstanceOf(PackInstallError);
    expect(existsSync(abs)).toBe(false);
  });

  it('rejects a symlink entry and never materializes the link', async () => {
    const entries: TarEntryInput[] = [
      { name: 'manifest.json', content: JSON.stringify(packManifest()) },
      { name: 'link', type: 'symlink', linkname: '/etc/passwd' },
    ];
    await expect(
      installPackFromStream(Readable.from(makeTarGz(entries)), installRoot),
    ).rejects.toBeInstanceOf(PackInstallError);
    expect(existsSync(join(installRoot, PACK_NAME, 'link'))).toBe(false);
  });
});

describe('@kgpacks/packs — installPackFromStream (archive + manifest faults)', () => {
  it('throws PackInstallError when the stream is not a valid gzip stream', async () => {
    await expect(
      installPackFromStream(Readable.from(Buffer.from('not gzip at all')), installRoot),
    ).rejects.toBeInstanceOf(PackInstallError);
  });

  it('throws ManifestValidationError when the archive has no manifest.json', async () => {
    const entries: TarEntryInput[] = [{ name: 'data.txt', content: 'no manifest here' }];
    await expect(
      installPackFromStream(Readable.from(makeTarGz(entries)), installRoot),
    ).rejects.toBeInstanceOf(ManifestValidationError);
  });

  it('enforces the uncompressed-size cap', async () => {
    const entries = benignEntries();
    await expect(
      installPackFromStream(Readable.from(makeTarGz(entries)), installRoot, {
        maxTotalBytes: 16,
      }),
    ).rejects.toBeInstanceOf(PackInstallError);
  });
});

describe('@kgpacks/packs — parseSizeField (large-pack size encodings)', () => {
  it('decodes the classic octal size field', () => {
    const buf = Buffer.alloc(12, 0);
    buf.write('00000001750\0', 0, 12, 'ascii'); // 0o1750 = 1000
    expect(parseSizeField(buf, 0)).toBe(1000);
  });

  it('decodes GNU base-256 size for values over the 8 GiB octal ceiling', () => {
    // 10 GiB does not fit in 11 octal digits; GNU tar uses base-256 with the
    // high bit of the first byte set.
    const tenGiB = 10 * 1024 * 1024 * 1024;
    const buf = Buffer.alloc(12, 0);
    buf[0] = 0x80;
    let v = tenGiB;
    for (let i = 11; i >= 1; i--) {
      buf[i] = v % 256;
      v = Math.floor(v / 256);
    }
    expect(parseSizeField(buf, 0)).toBe(tenGiB);
  });
});
