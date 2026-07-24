// packages/cli/test/helpers/mock-packs.ts
//
// Builds a throwaway packs directory on disk for the command tests. Constructing
// the fixture in code (rather than committing binary-ish blobs like `pack.db`)
// keeps every scenario reviewable and matches the `@kgpacks/packs` / `@kgpacks/mcp`
// test style.
//
// Layout produced under a fresh temp dir:
//   <root>/alpha-pack/   full manifest (graph_stats.articles=7) + pack.db
//   <root>/beta-pack/    minimal manifest, NO pack.db
//   <root>/broken-pack/  manifest with an invalid (non-SemVer) version
//   <root>/loose.txt     a loose file the registry must ignore

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A constructed mock packs directory. */
export interface MockPacks {
  /** Absolute path to the temp base (remove this to clean up). */
  base: string;
  /** Absolute path to the packs root inside {@link MockPacks.base}. */
  packsDir: string;
  /** Removes the entire fixture tree. */
  cleanup: () => void;
}

/** `alpha-pack` — a complete manifest with a database present. */
export const ALPHA_MANIFEST = {
  name: 'alpha-pack',
  version: '1.2.0',
  description: 'Alpha knowledge pack',
  graph_stats: { articles: 7, entities: 18, relationships: 12, size_mb: 0.9 },
} as const;

/** `beta-pack` — a minimal valid manifest, no database. */
export const BETA_MANIFEST = {
  name: 'beta-pack',
  version: '0.3.1',
} as const;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Creates the fixture tree under a fresh temp directory. */
export function makeMockPacks(): MockPacks {
  const base = mkdtempSync(join(tmpdir(), 'kgpacks-cli-'));
  const packsDir = join(base, 'packs');
  mkdirSync(packsDir, { recursive: true });

  const alphaDir = join(packsDir, 'alpha-pack');
  mkdirSync(alphaDir, { recursive: true });
  writeJson(join(alphaDir, 'manifest.json'), ALPHA_MANIFEST);
  writeFileSync(join(alphaDir, 'pack.db'), '');

  const betaDir = join(packsDir, 'beta-pack');
  mkdirSync(betaDir, { recursive: true });
  writeJson(join(betaDir, 'manifest.json'), BETA_MANIFEST);

  const brokenDir = join(packsDir, 'broken-pack');
  mkdirSync(brokenDir, { recursive: true });
  // Invalid version → loadManifestFromDir throws ManifestValidationError.
  writeFileSync(
    join(brokenDir, 'manifest.json'),
    JSON.stringify({ name: 'broken-pack', version: 'not-semver' }) + '\n',
  );

  writeFileSync(join(packsDir, 'loose.txt'), 'not a pack');

  return {
    base,
    packsDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
