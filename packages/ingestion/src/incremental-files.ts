import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot resolve filesystem for ${path}`);
    current = parent;
  }
  return current;
}

export function assertSameFilesystem(output: string, workDir: string): void {
  if (statSync(nearestExisting(dirname(output))).dev !== statSync(nearestExisting(workDir)).dev) {
    throw new Error('work directory must reside on the output filesystem');
  }
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...suffix);
}

export function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = canonicalPath(leftPath);
  const right = canonicalPath(rightPath);
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  const within = (value: string) =>
    value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
  return within(fromLeft) || within(fromRight);
}

export function assertDisjointPaths(base: string, output: string, workDir: string): void {
  if (pathsOverlap(base, output) || pathsOverlap(base, workDir) || pathsOverlap(output, workDir)) {
    throw new Error('base, output, and work directory paths must not overlap');
  }
}

export async function fileEntry(path: string, relativePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path: relativePath, size: statSync(path).size, sha256: hash.digest('hex') };
}

export function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function nativeRenameHelper(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER,
    join(moduleDir, 'rename-noreplace'),
    resolve(moduleDir, '../../../dist/rename-noreplace'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next deterministic package/source location.
    }
  }
  throw new Error('native renameat2(RENAME_NOREPLACE) helper is unavailable');
}

function runNoReplaceMove(
  source: string,
  destination: string,
  helper = nativeRenameHelper(),
): ReturnType<typeof spawnSync> {
  return spawnSync(helper, [source, destination], { encoding: 'utf8' });
}

export function assertNoReplacePublicationAvailable(filesystemPath: string): void {
  if (process.platform !== 'linux') {
    throw new Error('atomic no-replace publication requires Linux renameat2 support');
  }
  const helper = nativeRenameHelper();
  const probeRoot = mkdtempSync(join(filesystemPath, '.kgpacks-renameat2-'));
  const source = join(probeRoot, 'source');
  const destination = join(probeRoot, 'destination');
  try {
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, 'marker'), 'source');
    writeFileSync(join(destination, 'marker'), 'destination');
    const collision = runNoReplaceMove(source, destination, helper);
    if (
      collision.error ||
      collision.status !== 17 ||
      !existsSync(source) ||
      readFileSync(join(destination, 'marker'), 'utf8') !== 'destination'
    ) {
      throw new Error('target filesystem does not provide atomic RENAME_NOREPLACE semantics');
    }
    rmSync(destination, { recursive: true });
    const promotion = runNoReplaceMove(source, destination, helper);
    if (
      promotion.error ||
      promotion.status !== 0 ||
      existsSync(source) ||
      readFileSync(join(destination, 'marker'), 'utf8') !== 'source'
    ) {
      throw new Error('target filesystem cannot atomically promote with RENAME_NOREPLACE');
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

/**
 * The packaged native helper makes one renameat2(RENAME_NOREPLACE) syscall.
 * Unlike Node's rename(), it cannot replace a destination created concurrently.
 */
export function publishDirectoryNoReplace(staging: string, output: string): boolean {
  const moved = runNoReplaceMove(staging, output);
  if (moved.status === 17 && existsSync(staging)) return false;
  if (moved.error || moved.status !== 0) {
    throw new Error(
      `atomic no-replace publication failed: ${moved.error?.message ?? String(moved.stderr).trim()}`,
    );
  }
  if (existsSync(staging)) return false;
  if (!existsSync(output)) throw new Error('atomic publication completed without an output');
  return true;
}
