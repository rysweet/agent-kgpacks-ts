// Shared command context.
//
// Every command closes over a {@link CliContext}: the output sink, the `query`
// execution seam, and a `packsDirFor` resolver that folds the global
// `--packs-dir` flag into the configured precedence (flag → injection → env →
// default).

import type { Io } from './io.js';
import type { QueryRunner } from './query-runner.js';

/** Runtime dependencies shared by every command. */
export interface CliContext {
  /** Output sink for results and messages. */
  io: Io;
  /** `query` execution seam. */
  runQuery: QueryRunner;
  /** Resolves the packs directory given the global `--packs-dir` flag value. */
  packsDirFor: (flag?: string) => string;
}
