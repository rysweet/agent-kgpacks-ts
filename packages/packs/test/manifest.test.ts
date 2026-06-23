// packages/packs/test/manifest.test.ts
//
// Contract tests for the manifest model + validation documented in
// docs/packages/packs.md (Manifest API). Covers PACK_NAME_RE, validateManifest
// (accept + every documented rejection), the load/save round-trip (lossless,
// byte-exact 2-space + trailing newline), and the prototype-pollution guard.
//
// TDD: these FAIL today because packages/packs/src does not yet export the
// manifest surface. They PASS once manifest.ts lands.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MANIFEST_FILENAME,
  PACK_NAME_RE,
  loadManifest,
  loadManifestFromDir,
  saveManifest,
  validateManifest,
  ManifestValidationError,
} from '../src/index.js';
import type { PackManifest } from '../src/index.js';

const validManifest = (): PackManifest => ({
  name: 'world-history',
  version: '1.2.0',
  description: 'World history knowledge pack',
  graph_stats: { node_count: 12000, edge_count: 48000 },
  eval_scores: { recall_at_5: 0.81, faithfulness: 0.92 },
});

describe('@kgpacks/packs — MANIFEST_FILENAME', () => {
  it('is the canonical manifest.json', () => {
    expect(MANIFEST_FILENAME).toBe('manifest.json');
  });
});

describe('@kgpacks/packs — PACK_NAME_RE', () => {
  it.each(['world-history', 'a', 'A1_b-2', 'x'.repeat(64), '0pack'])(
    'accepts valid pack name %j',
    (name) => {
      expect(PACK_NAME_RE.test(name)).toBe(true);
    },
  );

  it.each([
    '',
    '../etc',
    '-leading',
    '_leading',
    'has space',
    'dot.name',
    'x'.repeat(65),
    'slash/name',
  ])('rejects invalid pack name %j', (name) => {
    expect(PACK_NAME_RE.test(name)).toBe(false);
  });
});

describe('@kgpacks/packs — validateManifest', () => {
  it('returns the typed manifest for a fully valid input', () => {
    const m = validManifest();
    expect(validateManifest(m)).toEqual(m);
  });

  it('accepts a minimal manifest with only name + version', () => {
    const m = { name: 'mini', version: '0.1.0' };
    expect(validateManifest(m)).toEqual(m);
  });

  it.each([
    ['missing name', { version: '1.0.0' }],
    ['non-string name', { name: 123, version: '1.0.0' }],
    ['name violating PACK_NAME_RE', { name: '../evil', version: '1.0.0' }],
    ['missing version', { name: 'ok' }],
    ['non-string version', { name: 'ok', version: 100 }],
    ['invalid semver version', { name: 'ok', version: '1.0' }],
  ])('throws ManifestValidationError on %s', (_label, bad) => {
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it.each([
    ['negative node_count', { node_count: -1, edge_count: 5 }],
    ['non-integer node_count', { node_count: 1.5, edge_count: 5 }],
    ['missing edge_count', { node_count: 5 }],
    ['non-number edge_count', { node_count: 5, edge_count: 'lots' }],
  ])('rejects malformed graph_stats (%s)', (_label, graph_stats) => {
    expect(() => validateManifest({ name: 'ok', version: '1.0.0', graph_stats })).toThrow(
      ManifestValidationError,
    );
  });

  it.each([
    ['NaN score', { recall: Number.NaN }],
    ['Infinity score', { recall: Number.POSITIVE_INFINITY }],
    ['non-number score', { recall: 'high' }],
  ])('rejects malformed eval_scores (%s)', (_label, eval_scores) => {
    expect(() => validateManifest({ name: 'ok', version: '1.0.0', eval_scores })).toThrow(
      ManifestValidationError,
    );
  });

  it('does not pollute Object.prototype via a dangerous __proto__ key', () => {
    const raw: unknown = JSON.parse(
      '{"name":"safe","version":"1.0.0","__proto__":{"polluted":true}}',
    );
    const m = validateManifest(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((m as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('@kgpacks/packs — manifest load/save round-trip', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kgpacks-packs-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadManifest reads, parses, and validates a manifest file', () => {
    const m = validManifest();
    const p = join(dir, 'manifest.json');
    writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
    expect(loadManifest(p)).toEqual(m);
  });

  it('loadManifestFromDir resolves MANIFEST_FILENAME under the pack directory', () => {
    const m = validManifest();
    writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(m, null, 2) + '\n');
    expect(loadManifestFromDir(dir)).toEqual(m);
  });

  it('preserves unknown keys across a save → load round-trip (lossless)', () => {
    const m: PackManifest = {
      ...validManifest(),
      tags: ['history', 'reference'],
      custom_meta: { source: 'wikipedia', revision: 42 },
    };
    const p = join(dir, MANIFEST_FILENAME);
    saveManifest(p, m);
    expect(loadManifest(p)).toEqual(m);
  });

  it('writes canonical 2-space-indented JSON terminated by exactly one newline', () => {
    const p = join(dir, MANIFEST_FILENAME);
    saveManifest(p, validManifest());
    const content = readFileSync(p, 'utf8');
    // Byte-exact: the file is canonical pretty-printed JSON + single trailing \n.
    expect(content).toBe(JSON.stringify(JSON.parse(content), null, 2) + '\n');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
    expect(content).toMatch(/\n {2}"name":/);
  });

  it('validates before writing — an invalid manifest leaves no file behind', () => {
    const p = join(dir, MANIFEST_FILENAME);
    expect(() => saveManifest(p, { name: '../bad', version: '1.0.0' } as PackManifest)).toThrow(
      ManifestValidationError,
    );
    expect(existsSync(p)).toBe(false);
  });

  it('loadManifest throws ManifestValidationError for a missing file', () => {
    expect(() => loadManifest(join(dir, 'nope.json'))).toThrow(ManifestValidationError);
  });

  it('loadManifest throws ManifestValidationError for invalid JSON', () => {
    const p = join(dir, MANIFEST_FILENAME);
    writeFileSync(p, '{ not valid json ');
    expect(() => loadManifest(p)).toThrow(ManifestValidationError);
  });

  it('loadManifest throws ManifestValidationError for schema-invalid JSON', () => {
    const p = join(dir, MANIFEST_FILENAME);
    writeFileSync(p, JSON.stringify({ name: 'ok', version: 'not-semver' }));
    expect(() => loadManifest(p)).toThrow(ManifestValidationError);
  });
});
