#!/usr/bin/env node
// Executable entry point: `kgpacks-mcp`.
//
// Boots the stdio server with production defaults. stdout is reserved for the
// JSON-RPC protocol stream, so startup failures are logged to stderr before a
// non-zero exit.

import { runStdioServer } from './stdio.js';

runStdioServer().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
