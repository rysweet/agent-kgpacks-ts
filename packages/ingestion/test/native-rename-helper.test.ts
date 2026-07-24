import { afterEach, describe, expect, it } from 'vitest';

import { nativeRenameHelper } from '../src/incremental-update.js';

const originalHelper = process.env.WIKIGR_RENAME_NOREPLACE_HELPER;

afterEach(() => {
  if (originalHelper === undefined) {
    delete process.env.WIKIGR_RENAME_NOREPLACE_HELPER;
  } else {
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER = originalHelper;
  }
});

describe('nativeRenameHelper', () => {
  it('rejects an invalid explicit helper instead of falling back to a bundled helper', () => {
    process.env.WIKIGR_RENAME_NOREPLACE_HELPER = '/does/not/exist/rename-noreplace';

    expect(() => nativeRenameHelper()).toThrow(/WIKIGR_RENAME_NOREPLACE_HELPER is not executable/);
  });
});
