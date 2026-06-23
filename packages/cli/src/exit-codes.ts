// Exit-code contract and the error → exit-code mapper.
//
// The CLI distinguishes failure classes by process exit code so scripts (and the
// tests) can branch on the kind of failure without parsing messages. Codes are
// stable and part of the package's public contract.
//
// Underlying package errors are matched by their `name` (every error class in
// `@kgpacks/packs` / `@kgpacks/query` sets `this.name` to its class name). This
// keeps this module dependency-free: it never imports `@kgpacks/query`, whose
// module graph eagerly loads the embeddings/ONNX runtime — that stays behind the
// lazy query runner.

import { CliError } from './errors.js';

/** Success. */
export const EXIT_OK = 0;
/** Generic / uncaught failure. */
export const EXIT_GENERIC = 1;
/** Usage / argument-parse error (commander). */
export const EXIT_USAGE = 2;
/** Pack not found (unknown or invalid pack name / missing directory). */
export const EXIT_PACK_NOT_FOUND = 3;
/** Manifest or Cypher validation failure. */
export const EXIT_VALIDATION = 4;
/** Pack install failure. */
export const EXIT_INSTALL = 5;
/** Query / retrieval runtime failure. */
export const EXIT_QUERY = 6;

const NAME_TO_CODE: Readonly<Record<string, number>> = {
  PackNotFoundError: EXIT_PACK_NOT_FOUND,
  ManifestValidationError: EXIT_VALIDATION,
  CypherValidationError: EXIT_VALIDATION,
  PackInstallError: EXIT_INSTALL,
  QueryError: EXIT_QUERY,
};

/** Maps a thrown value to the CLI exit code that should terminate the process. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof Error && err.name in NAME_TO_CODE) return NAME_TO_CODE[err.name];
  return EXIT_GENERIC;
}
