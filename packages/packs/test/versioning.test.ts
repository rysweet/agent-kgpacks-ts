// packages/packs/test/versioning.test.ts
//
// Contract tests for the SemVer 2.0 helpers documented in docs/packages/packs.md
// (Versioning API). A self-contained implementation — no `semver` dependency —
// so these pin parsing, precedence (including prerelease rules and ignored build
// metadata), sorting, and throw-on-invalid behavior.
//
// TDD: these FAIL today because packages/packs/src does not yet export the
// versioning surface. They PASS once versioning.ts lands.

import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isValidSemver,
  latestVersion,
  parseVersion,
  sortVersions,
  ManifestValidationError,
} from '../src/index.js';
import type { ParsedVersion } from '../src/index.js';

describe('@kgpacks/packs — parseVersion', () => {
  it('decomposes a full SemVer string into major/minor/patch/prerelease/build', () => {
    const parsed: ParsedVersion = parseVersion('1.4.2-rc.1+build.9');
    expect(parsed).toEqual({
      major: 1,
      minor: 4,
      patch: 2,
      prerelease: ['rc', '1'],
      build: ['build', '9'],
    });
  });

  it('parses a plain version with empty prerelease/build arrays', () => {
    expect(parseVersion('0.0.0')).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: [],
      build: [],
    });
  });

  it.each(['1.0', '1', 'v1.0.0', '1.0.0-', '1.0.0+', '01.0.0', '1.2.3.4', 'abc', ''])(
    'throws ManifestValidationError on invalid version %j',
    (bad) => {
      expect(() => parseVersion(bad)).toThrow(ManifestValidationError);
    },
  );
});

describe('@kgpacks/packs — isValidSemver', () => {
  it.each(['1.0.0', '0.0.0', '1.2.3-rc.1', '1.0.0-alpha+001', '1.0.0+build', '10.20.30'])(
    'accepts valid version %j',
    (v) => {
      expect(isValidSemver(v)).toBe(true);
    },
  );

  it.each(['1.0', 'v1.0.0', '1.0.0.0', '1.0.0-', '01.0.0', '1.0.0-01', ''])(
    'rejects invalid version %j',
    (v) => {
      expect(isValidSemver(v)).toBe(false);
    },
  );
});

describe('@kgpacks/packs — compareVersions', () => {
  it('orders by numeric major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a prerelease below the corresponding release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('compares prerelease identifiers per SemVer precedence rules', () => {
    // numeric identifiers compared numerically (not lexically)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    // alphanumeric compared lexically
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    // numeric identifiers have lower precedence than alphanumeric
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    // a larger set of identifiers wins when all preceding ones are equal
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  it('ignores build metadata for precedence', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(compareVersions('1.0.0-rc.1+a', '1.0.0-rc.1+b')).toBe(0);
  });
});

describe('@kgpacks/packs — sortVersions', () => {
  it('returns a new ascending array without mutating the input', () => {
    const input = ['1.2.0', '1.0.0', '1.1.0-rc.1', '1.1.0'];
    const sorted = sortVersions(input);
    expect(sorted).toEqual(['1.0.0', '1.1.0-rc.1', '1.1.0', '1.2.0']);
    expect(input).toEqual(['1.2.0', '1.0.0', '1.1.0-rc.1', '1.1.0']);
    expect(sorted).not.toBe(input);
  });

  it('honors the full canonical SemVer prerelease ordering chain', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    const shuffled = [...chain].reverse();
    expect(sortVersions(shuffled)).toEqual(chain);
  });

  it('compares arbitrarily large numeric identifiers without precision loss', () => {
    expect(compareVersions('9007199254740992.0.0', '9007199254740993.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBe(-1);
  });

  it('throws ManifestValidationError if any element is not valid SemVer', () => {
    expect(() => sortVersions(['1.0.0', 'nope'])).toThrow(ManifestValidationError);
  });
});

describe('@kgpacks/packs — latestVersion', () => {
  it('returns the highest-precedence version', () => {
    expect(latestVersion(['1.0.0', '1.2.0', '1.1.0'])).toBe('1.2.0');
    expect(latestVersion(['1.0.0', '1.0.0-rc.1'])).toBe('1.0.0');
  });

  it('preserves the last input when versions have equal precedence', () => {
    expect(latestVersion(['1.0.0+build.1', '1.0.0+build.2'])).toBe('1.0.0+build.2');
  });

  it('returns undefined for an empty list', () => {
    expect(latestVersion([])).toBeUndefined();
  });

  it('throws ManifestValidationError on an invalid element', () => {
    expect(() => latestVersion(['1.0.0', 'bad'])).toThrow(ManifestValidationError);
  });
});
