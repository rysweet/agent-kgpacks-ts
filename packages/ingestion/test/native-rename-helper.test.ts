import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nativeRenameHelper } from '../src/incremental-update.js';

const originalHelper = process.env.WIKIGR_RENAME_NOREPLACE_HELPER;
const roots: string[] = [];

afterEach(() => {
  if (originalHelper === undefined) {
    delete process.env.WIKIGR_RENAME_NOREPLACE_HELPER;
  } else {
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER = originalHelper;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('nativeRenameHelper', () => {
  it('rejects an invalid explicit helper instead of falling back to a bundled helper', () => {
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER = '/does/not/exist/rename-noreplace';

    expect(() => nativeRenameHelper()).toThrow(/WIKIGR_RENAME_NOREPLACE_HELPER is not executable/);
  });

  it('uses an explicit executable helper without probing architecture-specific candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'configured-rename-helper-'));
    roots.push(root);
    const helper = join(root, 'rename-noreplace');
    writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    chmodSync(helper, 0o755);
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER = helper;

    expect(nativeRenameHelper('unsupported-test-architecture')).toBe(helper);
  });

  it.each(['x64', 'arm64'])('selects the packaged Linux %s helper', (architecture) => {
    expect(basename(nativeRenameHelper(architecture))).toBe(
      `rename-noreplace-linux-${architecture}`,
    );
  });

  it('executes the host helper with no-replace collision semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'rename-noreplace-'));
    roots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, 'marker'), 'source');
    writeFileSync(join(destination, 'marker'), 'destination');

    const collision = spawnSync(nativeRenameHelper(), [source, destination], { encoding: 'utf8' });
    expect(collision.error).toBeUndefined();
    expect(collision.status).toBe(17);
    expect(existsSync(source)).toBe(true);

    rmSync(destination, { recursive: true });
    const moved = spawnSync(nativeRenameHelper(), [source, destination], { encoding: 'utf8' });
    expect(moved.error).toBeUndefined();
    expect(moved.status).toBe(0);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(destination, 'marker'))).toBe(true);
  });
});
