// Shared command context.
//
// Every command closes over a {@link CliContext}: the output sink, the `query`
// execution seam, and a `packsDirFor` resolver that folds the global
// `--packs-dir` flag into the configured precedence (flag → injection → env →
// default).

import type { EvalSeam } from './eval-runner.js';
import type { BuildPackSeam, DiscoverSourcesSeam } from './ingestion-runner.js';
import type { Io } from './io.js';
import type { QueryRunner } from './query-runner.js';
import type { UpdateKnowledgePackSeam } from './update-runner.js';

/** Runtime dependencies shared by every command. */
export interface CliContext {
  /** Output sink for results and messages. */
  io: Io;
  /** `query` execution seam. */
  runQuery: QueryRunner;
  /** `create` / `update` build seam (write-side ingestion pipeline). */
  buildPack: BuildPackSeam;
  /** Immutable incremental pack update seam. */
  updateKnowledgePack: UpdateKnowledgePackSeam;
  /** `research-sources` URL-discovery seam. */
  discoverSources: DiscoverSourcesSeam;
  /** `pack eval` execution seam. */
  evalPack: EvalSeam;
  /** Resolves the packs directory given the global `--packs-dir` flag value. */
  packsDirFor: (flag?: string) => string;
}
