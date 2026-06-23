// packages/cli/test/helpers/run-cli.ts
//
// Drives the CLI in-process with a buffered output sink, returning the resolved
// exit code together with the captured stdout/stderr. No subprocess is spawned,
// so assertions stay fast and deterministic.

import { run, type RunOptions } from '../../src/run.js';
import { createBufferedIo } from '../../src/io.js';

/** Result of one in-process CLI invocation. */
export interface CliRunResult {
  /** Resolved process exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** Runs the CLI for `argv`, capturing output and the exit code. */
export async function runCli(
  argv: string[],
  options: Omit<RunOptions, 'io'> = {},
): Promise<CliRunResult> {
  const io = createBufferedIo();
  const code = await run(argv, { ...options, io });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

/** Parses the (single-line) JSON document the CLI prints to stdout. */
export function parseStdout(result: CliRunResult): unknown {
  return JSON.parse(result.stdout);
}
