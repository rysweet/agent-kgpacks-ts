// CLI-local error carrying an explicit process exit code.
//
// The command bodies enforce a few preconditions before delegating to the
// underlying packages (an invalid/unknown pack for `query`, a missing database).
// Those raise a {@link CliError} whose `exitCode` is mapped straight through by
// the top-level handler, so the CLI's exit-code contract does not depend on the
// underlying packages re-exporting their error classes.

/** An error that maps directly to a CLI process exit code. */
export class CliError extends Error {
  /** Process exit code to terminate with. */
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
