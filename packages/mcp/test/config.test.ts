// packages/mcp/test/config.test.ts
//
// Covers packs-directory resolution: the `KGPACKS_PACKS_DIR` override wins when
// set, otherwise the server falls back to `<cwd>/data/packs` (the Python layout).

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PACKS_DIR_ENV } from '../src/constants.js';
import { resolveDefaultPacksDir } from '../src/config.js';

describe('resolveDefaultPacksDir', () => {
  it('defaults to <cwd>/data/packs', () => {
    expect(resolveDefaultPacksDir({}, '/srv/app')).toBe(join('/srv/app', 'data', 'packs'));
  });

  it('honors a non-empty KGPACKS_PACKS_DIR override', () => {
    expect(resolveDefaultPacksDir({ [PACKS_DIR_ENV]: '/custom/packs' }, '/srv/app')).toBe(
      '/custom/packs',
    );
  });

  it('ignores a blank override', () => {
    expect(resolveDefaultPacksDir({ [PACKS_DIR_ENV]: '   ' }, '/srv/app')).toBe(
      join('/srv/app', 'data', 'packs'),
    );
  });
});
