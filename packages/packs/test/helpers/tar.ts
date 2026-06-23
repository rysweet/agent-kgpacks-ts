// packages/packs/test/helpers/tar.ts
//
// A tiny, dependency-free `ustar` tar.gz writer used to build archive fixtures
// for the installer tests — both benign packs and adversarial ones. Building the
// archives in source (rather than committing binary blobs) keeps the malicious
// cases fully reviewable: every traversal / absolute / symlink entry below is
// visible in the test that constructs it.
//
// This is TEST tooling only. The package under test ships NO tar writer — the
// installer is read/extract-only — so this helper deliberately lives outside
// `src/` and is never exported from the package.

import { gzipSync } from 'node:zlib';

/** A logical tar entry to encode into a `ustar` archive. */
export interface TarEntryInput {
  /** The archived path (may be malicious: `../escape`, `/abs/path`, etc.). */
  name: string;
  /** Tar entry kind. Defaults to `'file'`. */
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'char' | 'block' | 'fifo';
  /** File contents (ignored for non-file entries). */
  content?: string | Buffer;
  /** Unix mode bits. Defaults to 0o644 for files, 0o755 for directories. */
  mode?: number;
  /** Link target for symlink / hardlink entries. */
  linkname?: string;
}

// ustar typeflag byte per POSIX: '0' file, '5' dir, '2' symlink, '1' hardlink,
// '3' char device, '4' block device, '6' FIFO.
const TYPEFLAG: Record<NonNullable<TarEntryInput['type']>, string> = {
  file: '0',
  dir: '5',
  symlink: '2',
  hardlink: '1',
  char: '3',
  block: '4',
  fifo: '6',
};

const BLOCK = 512;

// Encode a number as a zero-padded, NUL-terminated octal field of `fieldLen`
// bytes — the classic ustar numeric encoding.
function octalField(value: number, fieldLen: number): string {
  return value.toString(8).padStart(fieldLen - 1, '0') + '\0';
}

function buildHeader(entry: TarEntryInput, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const type = entry.type ?? 'file';
  const mode = entry.mode ?? (type === 'dir' ? 0o755 : 0o644);

  header.write(entry.name, 0, 100, 'utf8'); // name
  header.write(octalField(mode, 8), 100, 8, 'ascii'); // mode
  header.write(octalField(0, 8), 108, 8, 'ascii'); // uid
  header.write(octalField(0, 8), 116, 8, 'ascii'); // gid
  header.write(octalField(size, 12), 124, 12, 'ascii'); // size
  header.write(octalField(0, 12), 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  header.write(TYPEFLAG[type], 156, 1, 'ascii'); // typeflag
  if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8'); // linkname
  header.write('ustar\0', 257, 6, 'ascii'); // magic
  header.write('00', 263, 2, 'ascii'); // version

  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += header[i];
  // ustar checksum field: 6 octal digits, NUL, space.
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return header;
}

function entryData(entry: TarEntryInput): Buffer {
  const type = entry.type ?? 'file';
  if (type !== 'file') return Buffer.alloc(0);
  if (entry.content === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
}

/** Encode entries into an uncompressed `ustar` tar buffer. */
export function makeTar(entries: TarEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = entryData(entry);
    chunks.push(buildHeader(entry, data.length));
    if (data.length > 0) {
      chunks.push(data);
      const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  // Two trailing zero blocks mark end-of-archive.
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

/** Encode entries into a gzip-compressed `.tar.gz` buffer. */
export function makeTarGz(entries: TarEntryInput[]): Buffer {
  return gzipSync(makeTar(entries));
}
