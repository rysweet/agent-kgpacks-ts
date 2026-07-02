// packages/mcp/test/config.test.ts
//
// Covers packs-directory resolution: the `KGPACKS_PACKS_DIR` override wins when
// set, otherwise the server falls back to the XDG data dir (`$XDG_DATA_HOME/kgpacks`,
// else `~/.local/share/kgpacks`) — the SAME default the `wikigr` CLI resolves, so a
// pack installed by one is found by the other (docs/packs-directory.md).
//
// TDD (WS4): the XDG cases FAIL today (the server still defaults to
// `<cwd>/data/packs`) and pass once `resolveDefaultPacksDir` resolves the XDG default.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PACKS_DIR_ENV } from '../src/constants.js';
import { resolveDefaultPacksDir } from '../src/config.js';

describe('resolveDefaultPacksDir', () => {
  it('defaults to $XDG_DATA_HOME/kgpacks', () => {
    expect(resolveDefaultPacksDir({ XDG_DATA_HOME: '/xdg', HOME: '/home/bob' }, '/srv/app')).toBe(
      join('/xdg', 'kgpacks'),
    );
  });

  it('falls back to ~/.local/share/kgpacks when XDG_DATA_HOME is unset', () => {
    expect(resolveDefaultPacksDir({ HOME: '/home/bob' }, '/srv/app')).toBe(
      join('/home/bob', '.local', 'share', 'kgpacks'),
    );
  });

  it('honors a non-empty KGPACKS_PACKS_DIR override', () => {
    expect(
      resolveDefaultPacksDir({ [PACKS_DIR_ENV]: '/custom/packs', HOME: '/home/bob' }, '/srv/app'),
    ).toBe('/custom/packs');
  });

  it('ignores a blank override and uses the XDG default', () => {
    expect(resolveDefaultPacksDir({ [PACKS_DIR_ENV]: '   ', HOME: '/home/bob' }, '/srv/app')).toBe(
      join('/home/bob', '.local', 'share', 'kgpacks'),
    );
  });
});
