// Shared option-argument parsers.
//
// `parsePositiveInt` is the commander coercion used by every integer flag in the
// CLI (`query -k`, the ingestion bounds, `pack eval --per-pack`). Throwing
// `InvalidArgumentError` lets commander format a `--flag`-tagged usage error and
// exit `2`, so the diagnostic always names the offending option.

import { InvalidArgumentError } from 'commander';

/** Coerces a CLI argument to a positive integer, or throws a usage error. */
export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}
