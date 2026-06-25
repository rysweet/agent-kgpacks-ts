// packages/packs/test/registry.test.ts
//
// Contract tests for the registry documented in docs/packages/packs.md
// (Registry API): listPacks / packInfo / removePack over an install root. Also
// covers the registry-side path-safety control — name is re-validated against
// PACK_NAME_RE before any path is built or removed, so a malicious name can never
// traverse out of the install root.
//
// TDD: these FAIL today because packages/packs/src does not yet export the
// registry surface. They PASS once registry.ts lands.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listPacks,
  packInfo,
  removePack,
  ManifestValidationError,
  PackNotFoundError,
} from '../src/index.js';
import type { PackManifest } from '../src/index.js';

const alpha: PackManifest = { name: 'alpha', version: '1.0.0' };
const beta: PackManifest = {
  name: 'beta',
  version: '2.1.0',
  description: 'Beta pack',
  graph_stats: { articles: 7, entities: 11, relationships: 9, size_mb: 0.5 },
  eval_scores: { recall_at_5: 0.5 },
};

let base: string;
let root: string;

function writePack(installRoot: string, manifest: PackManifest): void {
  const dir = join(installRoot, manifest.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-packs-registry-'));
  root = join(base, 'packs');
  mkdirSync(root, { recursive: true });
  writePack(root, alpha);
  writePack(root, beta);
  // Noise the registry must ignore: a dir without a manifest, and a loose file.
  mkdirSync(join(root, 'not-a-pack'), { recursive: true });
  writeFileSync(join(root, 'not-a-pack', 'readme.txt'), 'no manifest here');
  writeFileSync(join(root, 'loose.txt'), 'stray file');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('@kgpacks/packs — listPacks', () => {
  it('lists every valid pack and skips directories without a valid manifest', () => {
    const names = listPacks(root)
      .map((p) => p.name)
      .sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('returns InstalledPack records with name, version, path, and manifest', () => {
    const betaPack = listPacks(root).find((p) => p.name === 'beta');
    expect(betaPack).toBeDefined();
    expect(betaPack?.version).toBe('2.1.0');
    expect(betaPack?.path).toBe(join(root, 'beta'));
    expect(betaPack?.manifest).toEqual(beta);
  });

  it('returns an empty array for a non-existent install root', () => {
    expect(listPacks(join(base, 'does-not-exist'))).toEqual([]);
  });
});

describe('@kgpacks/packs — packInfo', () => {
  it('returns the InstalledPack for an installed pack', () => {
    const info = packInfo(root, 'alpha');
    expect(info.name).toBe('alpha');
    expect(info.version).toBe('1.0.0');
    expect(info.path).toBe(join(root, 'alpha'));
    expect(info.manifest).toEqual(alpha);
  });

  it('throws PackNotFoundError for a valid name that is not installed', () => {
    expect(() => packInfo(root, 'ghost')).toThrow(PackNotFoundError);
  });

  it('throws ManifestValidationError for a malicious name before building any path', () => {
    expect(() => packInfo(root, '../outside')).toThrow(ManifestValidationError);
  });
});

describe('@kgpacks/packs — removePack', () => {
  it('removes an installed pack directory', () => {
    removePack(root, 'alpha');
    expect(existsSync(join(root, 'alpha'))).toBe(false);
    expect(listPacks(root).map((p) => p.name)).toEqual(['beta']);
    expect(() => packInfo(root, 'alpha')).toThrow(PackNotFoundError);
  });

  it('throws PackNotFoundError when removing a pack that is not installed', () => {
    expect(() => removePack(root, 'ghost')).toThrow(PackNotFoundError);
  });

  it('rejects a malicious name before any filesystem op and never touches a sibling', () => {
    const victim = join(base, 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep.txt'), 'precious');

    expect(() => removePack(root, '../victim')).toThrow(ManifestValidationError);
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
  });
});
