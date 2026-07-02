// packages/packs/test/provenance.test.ts
//
// TDD (RED): the manifest schema does not yet validate the `provenance` block, and
// @kgpacks/packs does not yet export `packVersionFromReleaseTag`, so this suite
// fails today. It encodes docs/pack-versioning.md — provenance string-validation +
// prototype-pollution stripping, and the immutable `<name>-YYYY.MM[.N]` release tag
// → SemVer version derivation (the month is zero-padded in the git TAG but MUST NOT
// be in the SemVer version, which forbids leading zeros in its numeric core).

import { describe, expect, it } from 'vitest';

import {
  isValidSemver,
  validateManifest,
  ManifestValidationError,
  packVersionFromReleaseTag,
} from '../src/index.js';

function baseManifest() {
  return {
    name: 'cve',
    version: '2025.6.0',
    description: 'Full CVE knowledge pack (MITRE/CVE Program corpus).',
    provenance: {
      corpus: { name: 'cvelistV5', commit: 'a1b2c3d4e5f6a7b8', date: '2025-06-14' },
      embedding: { model: 'Xenova/bge-base-en-v1.5', dimensions: 768 },
      build: { date: '2025-06-15T04:22:10Z', tool_version: 'agent-kgpacks-ts@0.0.0' },
    },
  };
}

describe('@kgpacks/packs — manifest provenance validation', () => {
  it('accepts and preserves a well-formed provenance block', () => {
    const m = validateManifest(baseManifest());
    expect(m.provenance).toEqual(baseManifest().provenance);
  });

  it('rejects a non-string provenance string field', () => {
    const bad = baseManifest();
    (bad.provenance.corpus as Record<string, unknown>).commit = 123;
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('strips prototype-pollution keys nested inside provenance', () => {
    const polluted = baseManifest();
    (polluted.provenance.corpus as Record<string, unknown>).constructor = 'nope';
    const m = validateManifest(polluted);
    const prov = m.provenance as { corpus: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(prov.corpus, 'constructor')).toBe(false);
  });
});

describe('@kgpacks/packs — packVersionFromReleaseTag', () => {
  it('derives an UNPADDED SemVer version from a dated release tag', () => {
    expect(packVersionFromReleaseTag('cve-2025.06')).toBe('2025.6.0');
    expect(packVersionFromReleaseTag('cve-2025.06.1')).toBe('2025.6.1');
    expect(packVersionFromReleaseTag('cve-2025.11')).toBe('2025.11.0');
  });

  it('always yields a valid SemVer 2.0 string', () => {
    for (const tag of ['cve-2025.06', 'cve-2025.06.1', 'cve-2025.11']) {
      expect(isValidSemver(packVersionFromReleaseTag(tag))).toBe(true);
    }
  });

  it('throws on a tag that carries no dated version (e.g. the "packs" latest pointer)', () => {
    for (const tag of ['packs', 'cve', 'cve-latest', '']) {
      expect(() => packVersionFromReleaseTag(tag)).toThrow(ManifestValidationError);
    }
  });
});
