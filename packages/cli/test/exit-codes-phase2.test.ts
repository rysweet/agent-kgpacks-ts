// packages/cli/test/exit-codes-phase2.test.ts
//
// The Phase-2 extension of the error → exit-code mapper: ingestion failures map to
// `7` and eval failures to `8`. Errors are matched by their `name` string only, so
// this exercises that contract WITHOUT importing the heavy `@kgpacks/ingestion` /
// `@kgpacks/eval` packages (exactly as the production mapper must, to stay free of
// the embedding/model runtime). Kept separate from the Phase-1 `exit-codes.test.ts`
// so that suite stays green until these new exports exist.

import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import { EXIT_EVAL, EXIT_INGESTION, exitCodeFor } from '../src/exit-codes.js';

/** A plain Error stamped with `name` — the only thing the mapper inspects. */
function named(name: string, message = 'boom'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('Phase-2 exit-code constants', () => {
  it('pins ingestion to 7 and eval to 8', () => {
    expect(EXIT_INGESTION).toBe(7);
    expect(EXIT_EVAL).toBe(8);
  });
});

describe('exitCodeFor — ingestion failures (7)', () => {
  it.each(['IngestionError', 'BlockedUrlError', 'FetchError', 'ExtractionError'])(
    'maps %s to 7 by name',
    (name) => {
      expect(exitCodeFor(named(name))).toBe(EXIT_INGESTION);
    },
  );

  it('honours an explicit CliError carrying EXIT_INGESTION', () => {
    expect(exitCodeFor(new CliError('x', EXIT_INGESTION))).toBe(EXIT_INGESTION);
  });
});

describe('exitCodeFor — eval failures (8)', () => {
  it('maps EvalError to 8 by name', () => {
    expect(exitCodeFor(named('EvalError'))).toBe(EXIT_EVAL);
  });

  it('honours an explicit CliError carrying EXIT_EVAL', () => {
    expect(exitCodeFor(new CliError('x', EXIT_EVAL))).toBe(EXIT_EVAL);
  });
});

describe('exit-code contract stability', () => {
  it('keeps the new codes distinct from the generic fallthrough and each other', () => {
    expect(new Set([EXIT_INGESTION, EXIT_EVAL]).size).toBe(2);
    expect(exitCodeFor(named('SomethingUnmapped'))).not.toBe(EXIT_INGESTION);
    expect(exitCodeFor(named('SomethingUnmapped'))).not.toBe(EXIT_EVAL);
  });
});
