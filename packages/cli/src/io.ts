// Output sink abstraction.
//
// Every byte the CLI emits goes through an {@link Io}: command results and
// commander's own help/error text alike. Production wires it to the process
// streams; tests inject buffers so stdout/stderr can be asserted and the
// help/usage snapshots captured without spawning a subprocess.

/** A sink for the two CLI output streams. */
export interface Io {
  /** Writes raw text to stdout (no newline added). */
  out(text: string): void;
  /** Writes raw text to stderr (no newline added). */
  err(text: string): void;
}

/** The default {@link Io}, writing straight to the process streams. */
export const processIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** A buffered {@link Io} that accumulates writes for inspection in tests. */
export interface BufferedIo extends Io {
  /** Everything written to stdout so far. */
  stdout(): string;
  /** Everything written to stderr so far. */
  stderr(): string;
}

/** Creates a {@link BufferedIo}. */
export function createBufferedIo(): BufferedIo {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** Serializes `value` as pretty JSON and writes it as one line to stdout. */
export function printJson(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2) + '\n');
}
