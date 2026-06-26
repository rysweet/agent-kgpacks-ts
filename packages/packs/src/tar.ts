// Minimal, read-only `ustar` tar parser (internal to the installer).
//
// The package ships NO tar writer — extraction is read-only — so this lives in
// src/ and only decodes the fields the installer needs to make security
// decisions: each entry's full path, its typeflag, and (for regular files) its
// bytes. Checksums are not verified; malformed archives surface as rejected or
// invalid entries downstream.

export const TAR_BLOCK = 512;
const BLOCK = TAR_BLOCK;

export type TarEntryType =
  | 'file'
  | 'dir'
  | 'symlink'
  | 'hardlink'
  | 'char'
  | 'block'
  | 'fifo'
  | 'other';

export interface TarEntry {
  name: string;
  type: TarEntryType;
  content: Buffer;
}

function readString(buf: Buffer, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf8', off, end);
}

function parseOctal(buf: Buffer, off: number, len: number): number {
  let digits = '';
  for (let i = off; i < off + len; i++) {
    const c = buf[i];
    if (c === 0 || c === 0x20) {
      if (digits.length > 0) break;
      continue;
    }
    digits += String.fromCharCode(c);
  }
  return digits.length > 0 ? parseInt(digits, 8) : 0;
}

/**
 * Reads a tar numeric size field (12 bytes at `off`). Supports both the classic
 * octal-ASCII encoding and GNU/star base-256 encoding (used when a value does
 * not fit in 11 octal digits, i.e. files larger than 8 GiB), so multi-GB packs
 * round-trip correctly.
 */
export function parseSizeField(buf: Buffer, off: number): number {
  // base-256: high bit of the first byte is set; remaining bytes are a
  // big-endian magnitude. The sign bit (0x40) is never set for sizes.
  if ((buf[off] & 0x80) !== 0) {
    let value = 0;
    for (let i = off + 1; i < off + 12; i++) {
      value = value * 256 + buf[i];
    }
    return value;
  }
  return parseOctal(buf, off, 12);
}

export function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = off; i < off + BLOCK; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function mapType(typeByte: number, name: string): TarEntryType {
  switch (String.fromCharCode(typeByte)) {
    case '0':
    case '\0':
    case '7':
      return name.endsWith('/') ? 'dir' : 'file';
    case '5':
      return 'dir';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    case '3':
      return 'char';
    case '4':
      return 'block';
    case '6':
      return 'fifo';
    default:
      return 'other';
  }
}

export interface TarHeader {
  name: string;
  type: TarEntryType;
  size: number;
}

/**
 * Decodes a single 512-byte tar header block into the fields the installer
 * needs. The caller is responsible for first checking {@link isZeroBlock}
 * (an end-of-archive marker decodes to an empty-named entry here).
 */
export function parseTarHeader(block: Buffer, off = 0): TarHeader {
  const name = readString(block, off, 100);
  const prefix = readString(block, off + 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  const size = parseSizeField(block, off + 124);
  const type = mapType(block[off + 156], fullName);
  return { name: fullName, type, size };
}

export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + BLOCK <= buf.length) {
    if (isZeroBlock(buf, pos)) break; // a zero block marks end-of-archive
    const { name: fullName, type, size } = parseTarHeader(buf, pos);
    pos += BLOCK;
    let content: Buffer = Buffer.alloc(0);
    if (size > 0) {
      content = buf.subarray(pos, pos + size);
      pos += Math.ceil(size / BLOCK) * BLOCK;
    }
    entries.push({ name: fullName, type, content });
  }
  return entries;
}
