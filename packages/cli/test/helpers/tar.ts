// packages/cli/test/helpers/tar.ts
//
// A minimal `ustar` tar.gz writer for the install integration tests. The
// production code ships NO tar writer (extraction is read-only), so the tests
// build their own archive in code — keeping the fixture reviewable and matching
// the `@kgpacks/packs` installer's expected on-disk format (regular-file entries,
// 512-byte blocks, a valid header checksum, and the two trailing zero blocks).

import { gzipSync } from 'node:zlib';

const BLOCK = 512;

/** One file to place in the archive. */
export interface TarFileInput {
  /** Entry path within the archive (e.g. `manifest.json`). */
  name: string;
  /** UTF-8 file contents. */
  content: string;
}

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'utf8');
  h.write('0000644', 100, 'ascii'); // mode
  h.write('0000000', 108, 'ascii'); // uid
  h.write('0000000', 116, 'ascii'); // gid
  h.write(size.toString(8).padStart(11, '0') + ' ', 124, 'ascii'); // size
  h.write('00000000000 ', 136, 'ascii'); // mtime
  h.write('        ', 148, 'ascii'); // checksum field initialized to spaces
  h.write('0', 156, 'ascii'); // typeflag: regular file
  h.write('ustar', 257, 'ascii');
  h.write('00', 263, 'ascii');

  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function fileBlocks(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([header(name, data.length), data, padding]);
}

/** Builds a gzip-compressed tar archive from `files`. */
export function makeTarGz(files: TarFileInput[]): Buffer {
  const blocks = files.map((f) => fileBlocks(f.name, f.content));
  const trailer = Buffer.alloc(BLOCK * 2); // end-of-archive marker
  return gzipSync(Buffer.concat([...blocks, trailer]));
}
