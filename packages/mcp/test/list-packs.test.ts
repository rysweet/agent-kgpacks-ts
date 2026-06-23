// packages/mcp/test/list-packs.test.ts
//
// Byte-compatibility tests for the `list_packs` tool, mirroring the Python
// `mcp_server.py`: a 2-space-indented JSON array of `{ name, description,
// article_count }` sorted by directory name, with a compact `{ error, path }`
// payload when the packs directory is absent.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listPacksText } from '../src/tools.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';

let packs: MockPacks;

beforeEach(() => {
  packs = makeMockPacks();
});

afterEach(() => {
  packs.cleanup();
});

describe('list_packs', () => {
  it('lists packs sorted by directory name with name/description/article_count', () => {
    const expected = `[
  {
    "name": "alpha-pack",
    "description": "Alpha knowledge pack",
    "article_count": 42
  },
  {
    "name": "beta",
    "description": "Beta knowledge pack",
    "article_count": 0
  },
  {
    "name": "gamma-no-manifest",
    "description": "",
    "article_count": 0
  }
]`;
    expect(listPacksText(packs.packsDir)).toBe(expected);
  });

  it('takes name from the manifest, falling back to the directory name', () => {
    const parsed = JSON.parse(listPacksText(packs.packsDir)) as Array<Record<string, unknown>>;
    // beta-pack's manifest.name is "beta" (differs from the dir); gamma has no
    // manifest so it falls back to the directory name.
    expect(parsed.map((p) => p.name)).toEqual(['alpha-pack', 'beta', 'gamma-no-manifest']);
  });

  it('ignores loose files at the packs root', () => {
    const parsed = JSON.parse(listPacksText(packs.packsDir)) as unknown[];
    expect(parsed).toHaveLength(3);
  });

  it('returns the compact error payload when the packs directory is missing', () => {
    const missing = join(packs.packsDir, 'does-not-exist');
    expect(listPacksText(missing)).toBe(
      `{"error": "Packs directory not found", "path": ${JSON.stringify(missing)}}`,
    );
  });

  it('returns an empty JSON array for an empty packs directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kgpacks-mcp-empty-'));
    try {
      mkdirSync(empty, { recursive: true });
      expect(listPacksText(empty)).toBe('[]');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
