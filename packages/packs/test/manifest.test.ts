// packages/packs/test/manifest.test.ts
//
// Contract tests for the manifest model + validation documented in
// docs/packages/packs.md (Manifest API). Covers PACK_NAME_RE, validateManifest
// (accept + every documented rejection), the load/save round-trip (lossless,
// byte-exact 2-space + trailing newline), and the prototype-pollution guard.
//
// TDD: these FAIL today because packages/packs/src does not yet export the
// manifest surface. They PASS once manifest.ts lands.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  graph_stats: { articles: 12000, entities: 4800, relationships: 9100, size_mb: 18.4 },
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

  it('accepts the immutable update version grammar for schema-v2 manifests', () => {
    expect(validateManifest({ name: 'cve', version: '2026.07', schemaVersion: '2' }).version).toBe(
      '2026.07',
    );
    expect(() => validateManifest({ name: 'cve', version: '2026.07' })).toThrow();
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

  it('accepts the real catalog graph_stats shape (float size_mb, no node_count)', () => {
    const m = {
      name: 'rust-expert',
      version: '1.0.0',
      graph_stats: { articles: 294, entities: 1388, relationships: 1190, size_mb: 2.08 },
    };
    expect(validateManifest(m)).toEqual(m);
  });

  it.each([
    ['negative count', { articles: -1 }],
    ['non-number stat', { articles: 5, entities: 'lots' }],
    ['NaN stat', { articles: Number.NaN }],
    ['Infinity stat', { size_mb: Number.POSITIVE_INFINITY }],
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

// Anti-drift: validate the REAL committed pack manifests so the validator can
// never again diverge from the shape this platform actually ships (the cause of
// the layer-16 `graph_stats` finding, where every real manifest was rejected).
describe('@kgpacks/packs — validateManifest accepts every real catalog manifest', () => {
  const catalogDir = join(process.cwd(), '..', '..', 'catalog');
  const packs = existsSync(catalogDir)
    ? readdirSync(catalogDir).filter((p) => existsSync(join(catalogDir, p, MANIFEST_FILENAME)))
    : [];

  it('finds committed catalog manifests to check', () => {
    expect(packs.length).toBeGreaterThan(0);
  });

  it.each(packs)('validates the real manifest for %s', (pack) => {
    const raw: unknown = JSON.parse(
      readFileSync(join(catalogDir, pack, MANIFEST_FILENAME), 'utf8'),
    );
    expect(() => validateManifest(raw)).not.toThrow();
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
