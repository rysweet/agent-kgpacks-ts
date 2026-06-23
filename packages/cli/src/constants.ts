// @kgpacks/cli — program identity and runtime defaults.
//
// The binary is `wikigr` (the upstream CLI name, preserved so existing
// invocations and docs keep working). These constants are the single source of
// truth the program wiring and the help/usage snapshots lock onto.

/** Executable / commander program name (matches the upstream CLI). */
export const PROGRAM_NAME = 'wikigr';

/** Version reported by `wikigr --version`. */
export const CLI_VERSION = '0.0.0';

/** Environment variable overriding the packs directory. */
export const PACKS_DIR_ENV = 'KGPACKS_PACKS_DIR';

/** Per-pack LadybugDB database filename. */
export const DB_FILENAME = 'pack.db';

/** Default top-k for `query` (matches the upstream / MCP default). */
export const DEFAULT_K = 5;

/** Default retrieval mode for `query`. */
export const DEFAULT_MODE = 'vector';

/** Retrieval modes accepted by `query --mode`. */
export const RETRIEVE_MODES = ['vector', 'hybrid'] as const;
