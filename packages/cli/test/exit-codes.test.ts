// packages/cli/test/exit-codes.test.ts
//
// The error → exit-code mapper. Covers the CLI-local CliError (explicit code),
// the underlying package error classes (matched by name), and the generic
// fallthrough.

import { ManifestValidationError, PackInstallError, PackNotFoundError } from '@kgpacks/packs';
import { CypherValidationError, QueryError } from '@kgpacks/query';
import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import {
  EXIT_GENERIC,
  EXIT_INSTALL,
  EXIT_PACK_NOT_FOUND,
  EXIT_QUERY,
  EXIT_VALIDATION,
  exitCodeFor,
} from '../src/exit-codes.js';

describe('exitCodeFor', () => {
  it('honors an explicit CliError exit code', () => {
    expect(exitCodeFor(new CliError('nope', EXIT_PACK_NOT_FOUND))).toBe(EXIT_PACK_NOT_FOUND);
    expect(exitCodeFor(new CliError('boom', EXIT_QUERY))).toBe(EXIT_QUERY);
  });

  it('maps PackNotFoundError to 3', () => {
    expect(exitCodeFor(new PackNotFoundError('x'))).toBe(EXIT_PACK_NOT_FOUND);
  });

  it('maps manifest and Cypher validation errors to 4', () => {
    expect(exitCodeFor(new ManifestValidationError('x'))).toBe(EXIT_VALIDATION);
    expect(exitCodeFor(new CypherValidationError('x'))).toBe(EXIT_VALIDATION);
  });

  it('maps PackInstallError to 5', () => {
    expect(exitCodeFor(new PackInstallError('x'))).toBe(EXIT_INSTALL);
  });

  it('maps QueryError to 6', () => {
    expect(exitCodeFor(new QueryError('x'))).toBe(EXIT_QUERY);
  });

  it('falls through to the generic code for anything else', () => {
    expect(exitCodeFor(new Error('???'))).toBe(EXIT_GENERIC);
    expect(exitCodeFor('a string')).toBe(EXIT_GENERIC);
  });
});
