// packages/mcp/test/pack-info.test.ts
//
// Byte-compatibility tests for the `pack_info` tool: the full manifest plus the
// computed `db_exists` / `urls_file_exists` flags (2-space indented), an unknown
// pack raising the Python "not found" message, and path-traversal names being
// rejected with that same message (PACK_NAME_RE gate).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packNotFoundMessage } from '../src/constants.js';
import { packInfoText } from '../src/tools.js';
import { makeMockPacks, type MockPacks } from './helpers/mock-packs.js';

let packs: MockPacks;

beforeEach(() => {
  packs = makeMockPacks();
});

afterEach(() => {
  packs.cleanup();
});

describe('pack_info', () => {
  it('returns the full manifest with db_exists/urls_file_exists appended', () => {
    // alpha-pack has both pack.db and urls.txt, appended after the manifest keys.
    const expected = JSON.stringify(
      { ...packs.alphaManifest, db_exists: true, urls_file_exists: true },
      null,
      2,
    );
    expect(packInfoText(packs.packsDir, 'alpha-pack')).toBe(expected);
  });

  it('reports db_exists/urls_file_exists false when the files are absent', () => {
    const expected = JSON.stringify(
      { ...packs.betaManifest, db_exists: false, urls_file_exists: false },
      null,
      2,
    );
    expect(packInfoText(packs.packsDir, 'beta-pack')).toBe(expected);
  });

  it('returns the missing-manifest stand-in for a manifest-less directory', () => {
    const expected = JSON.stringify(
      {
        name: 'gamma-no-manifest',
        error: 'manifest.json missing',
        db_exists: false,
        urls_file_exists: false,
      },
      null,
      2,
    );
    expect(packInfoText(packs.packsDir, 'gamma-no-manifest')).toBe(expected);
  });

  it('throws the Python "not found" message for an unknown pack', () => {
    expect(() => packInfoText(packs.packsDir, 'nope')).toThrow(packNotFoundMessage('nope'));
  });

  it('rejects path-traversal names with the same "not found" message', () => {
    for (const name of ['../etc', '..', 'a/b', 'foo/../bar']) {
      expect(() => packInfoText(packs.packsDir, name)).toThrow(packNotFoundMessage(name));
    }
  });
});
