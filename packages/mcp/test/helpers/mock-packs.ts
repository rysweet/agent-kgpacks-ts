// packages/mcp/test/helpers/mock-packs.ts
//
// Builds a throwaway packs directory on disk for the tool tests. Constructing the
// fixture in code (rather than committing binary-ish blobs like `pack.db`) keeps
// every scenario reviewable and matches the `@kgpacks/packs` test style.
//
// Layout produced:
//   <root>/alpha-pack/        full manifest (graph_stats.articles=42) + pack.db + urls.txt
//   <root>/beta-pack/         manifest whose `name` differs from the dir; no db / urls
//   <root>/gamma-no-manifest/ directory with no manifest.json
//   <root>/not-a-pack.txt     loose file the tools must ignore

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A constructed mock packs directory plus the manifests written into it. */
export interface MockPacks {
  /** Absolute path to the packs root. */
  packsDir: string;
  /** Manifest written to `alpha-pack/manifest.json`. */
  alphaManifest: Record<string, unknown>;
  /** Manifest written to `beta-pack/manifest.json`. */
  betaManifest: Record<string, unknown>;
  /** Removes the entire fixture tree. */
  cleanup: () => void;
}

/** `alpha-pack` — a complete manifest with article stats, a db, and a urls file. */
export const ALPHA_MANIFEST: Record<string, unknown> = {
  name: 'alpha-pack',
  version: '1.2.0',
  description: 'Alpha knowledge pack',
  graph_stats: { node_count: 100, edge_count: 250, articles: 42 },
  eval_scores: { recall_at_5: 0.8 },
};

/** `beta-pack` — manifest `name` deliberately differs from the directory name. */
export const BETA_MANIFEST: Record<string, unknown> = {
  name: 'beta',
  version: '0.3.1',
  description: 'Beta knowledge pack',
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Creates the fixture tree under a fresh temp directory. */
export function makeMockPacks(): MockPacks {
  const base = mkdtempSync(join(tmpdir(), 'kgpacks-mcp-'));
  const packsDir = join(base, 'packs');
  mkdirSync(packsDir, { recursive: true });

  const alphaDir = join(packsDir, 'alpha-pack');
  mkdirSync(alphaDir, { recursive: true });
  writeJson(join(alphaDir, 'manifest.json'), ALPHA_MANIFEST);
  writeFileSync(join(alphaDir, 'pack.db'), 'placeholder db');
  writeFileSync(join(alphaDir, 'urls.txt'), 'https://example.com/article\n');

  const betaDir = join(packsDir, 'beta-pack');
  mkdirSync(betaDir, { recursive: true });
  writeJson(join(betaDir, 'manifest.json'), BETA_MANIFEST);

  mkdirSync(join(packsDir, 'gamma-no-manifest'), { recursive: true });
  writeFileSync(join(packsDir, 'not-a-pack.txt'), 'loose file');

  return {
    packsDir,
    alphaManifest: ALPHA_MANIFEST,
    betaManifest: BETA_MANIFEST,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
