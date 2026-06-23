// Self-contained SemVer 2.0 helpers (no `semver` dependency).
//
// Ports the precedence rules of the upstream versioning module: numeric core
// comparison, prerelease-below-release, identifier-by-identifier prerelease
// precedence (numeric < alphanumeric, numeric compared numerically), and build
// metadata parsed but ignored for ordering. Invalid input throws so callers get
// the upstream raise/throw semantics.

import { ManifestValidationError } from './errors.js';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

// Official SemVer 2.0 grammar, anchored. Numeric core forbids leading zeros;
// prerelease identifiers forbid leading-zero numerics; build metadata is lax.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(v: string): boolean {
  return typeof v === 'string' && SEMVER_RE.test(v);
}

export function parseVersion(v: string): ParsedVersion {
  if (typeof v !== 'string') {
    throw new ManifestValidationError(`invalid version: expected a string, got ${typeof v}`);
  }
  const match = SEMVER_RE.exec(v);
  if (!match) {
    throw new ManifestValidationError(`invalid version "${v}" (must be valid SemVer 2.0)`);
  }
  const [, major, minor, patch, prerelease, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
    build: build ? build.split('.') : [],
  };
}

const isNumericId = (id: string): boolean => /^\d+$/.test(id);

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // a is a prefix of b → lower precedence
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    const xn = isNumericId(x);
    const yn = isNumericId(y);
    if (xn && yn) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx < ny) return -1;
      if (nx > ny) return 1;
    } else if (xn && !yn) {
      return -1; // numeric identifiers have lower precedence than alphanumeric
    } else if (!xn && yn) {
      return 1;
    } else {
      if (x < y) return -1;
      if (x > y) return 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] < pb[key]) return -1;
    if (pa[key] > pb[key]) return 1;
  }
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1; // a is a release, b is a prerelease → a is higher
  if (!bPre) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function sortVersions(versions: string[]): string[] {
  for (const v of versions) parseVersion(v); // validate every element up front
  return [...versions].sort(compareVersions);
}

export function latestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  const sorted = sortVersions(versions);
  return sorted[sorted.length - 1];
}
