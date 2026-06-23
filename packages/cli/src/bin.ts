#!/usr/bin/env node
// Executable entry point: `wikigr`.
//
// Parses the process arguments, then translates the resolved exit code into the
// real process exit. This is the ONLY place that calls `process.exit`, keeping
// the rest of the package pure and testable.

import { run } from './run.js';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
