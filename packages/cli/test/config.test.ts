// packages/cli/test/config.test.ts
//
// The packs-directory precedence contract: flag > injection > env > XDG default.
//
// TDD (WS4): the default is being moved OFF the cwd-relative `./data/packs` to an
// XDG data dir (`$XDG_DATA_HOME/kgpacks`, falling back to `~/.local/share/kgpacks`)
// so the installed CLI finds packs from anywhere (docs/packs-directory.md). The
// XDG cases below FAIL today (the default is still `<cwd>/data/packs`) and pass
// once `resolvePacksDir` resolves the XDG default; the top-three precedence rules
// are unchanged.

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
    const dir = resolvePacksDir({
      env: { [PACKS_DIR_ENV]: '/from/env', HOME: '/home/alice' },
      cwd: '/cwd',
    });
    expect(dir).toBe('/from/env');
  });

  it('falls back to $XDG_DATA_HOME/kgpacks by default', () => {
    const dir = resolvePacksDir({
      env: { XDG_DATA_HOME: '/xdg/data', HOME: '/home/alice' },
      cwd: '/cwd',
    });
    expect(dir).toBe(join('/xdg/data', 'kgpacks'));
  });

  it('falls back to ~/.local/share/kgpacks when XDG_DATA_HOME is unset', () => {
    const dir = resolvePacksDir({ env: { HOME: '/home/alice' }, cwd: '/cwd' });
    expect(dir).toBe(join('/home/alice', '.local', 'share', 'kgpacks'));
  });

  it('treats empty / whitespace overrides as unset and uses the XDG default', () => {
    const dir = resolvePacksDir({
      flag: '   ',
      injected: '',
      env: { [PACKS_DIR_ENV]: '  ', XDG_DATA_HOME: '  ', HOME: '/home/alice' },
      cwd: '/cwd',
    });
    expect(dir).toBe(join('/home/alice', '.local', 'share', 'kgpacks'));
  });
});
