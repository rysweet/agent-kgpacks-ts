// Minimal, read-only `ustar` tar parser (internal to the installer).
//
// The package ships NO tar writer — extraction is read-only — so this lives in
// src/ and only decodes the fields the installer needs to make security
// decisions: each entry's full path, its typeflag, and (for regular files) its
// bytes. Checksums are not verified; malformed archives surface as rejected or
// invalid entries downstream.

const BLOCK = 512;

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

function isZeroBlock(buf: Buffer, off: number): boolean {
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

export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + BLOCK <= buf.length) {
    if (isZeroBlock(buf, pos)) break; // a zero block marks end-of-archive
    const name = readString(buf, pos, 100);
    const prefix = readString(buf, pos + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseOctal(buf, pos + 124, 12);
    const type = mapType(buf[pos + 156], fullName);
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
