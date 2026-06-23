// packages/cli/test/config.test.ts
//
// The packs-directory precedence contract: flag > injection > env > default.

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePacksDir } from '../src/config.js';
import { PACKS_DIR_ENV } from '../src/constants.js';

describe('resolvePacksDir', () => {
  it('prefers the explicit --packs-dir flag above everything else', () => {
    const dir = resolvePacksDir({
      flag: '/from/flag',
      injected: '/from/injection',
      env: { [PACKS_DIR_ENV]: '/from/env' },
      cwd: '/cwd',
    });
    expect(dir).toBe('/from/flag');
  });

  it('falls back to the programmatic injection when no flag is given', () => {
    const dir = resolvePacksDir({
      injected: '/from/injection',
      env: { [PACKS_DIR_ENV]: '/from/env' },
      cwd: '/cwd',
    });
    expect(dir).toBe('/from/injection');
  });

  it('falls back to KGPACKS_PACKS_DIR when neither flag nor injection is set', () => {
    const dir = resolvePacksDir({ env: { [PACKS_DIR_ENV]: '/from/env' }, cwd: '/cwd' });
    expect(dir).toBe('/from/env');
  });

  it('falls back to <cwd>/data/packs by default', () => {
    const dir = resolvePacksDir({ env: {}, cwd: '/cwd' });
    expect(dir).toBe(join('/cwd', 'data', 'packs'));
  });

  it('treats empty / whitespace overrides as unset', () => {
    const dir = resolvePacksDir({ flag: '   ', injected: '', env: {}, cwd: '/cwd' });
    expect(dir).toBe(join('/cwd', 'data', 'packs'));
  });
});
