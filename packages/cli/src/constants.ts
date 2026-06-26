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

// ── INGESTION (Phase 2) ─────────────────────────────────────────────────────

/** Default link-expansion depth for `create` / `update` / `research-sources`. */
export const DEFAULT_MAX_DEPTH = 1;

/** Default hard cap on articles ingested by `create` / `update` / `research-sources`. */
export const DEFAULT_MAX_ARTICLES = 50;

// ── EVAL (Phase 2) ──────────────────────────────────────────────────────────

/** Sampling modes accepted by `pack eval --sample`. */
export const SAMPLE_MODES = ['full', 'stratified'] as const;

/** Default sampling mode for `pack eval`. */
export const DEFAULT_SAMPLE = 'full';

/** Default questions-per-pack for `pack eval --sample stratified`. */
export const DEFAULT_PER_PACK = 3;

/**
 * Default judge model for `pack eval`, held constant across both arms. Mirrors
 * `@kgpacks/eval`'s `DEFAULT_JUDGE_MODEL` (`claude-opus-4.5`, the Opus model served
 * by the authenticated Copilot CLI); overriding it re-baselines the eval.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-4.5';

// ── PACK RELEASE / PULL ──────────────────────────────────────────────────────

/** Default source repository for `pack pull` (GitHub Releases host the artifacts). */
export const DEFAULT_PACK_REPO = 'rysweet/agent-kgpacks-ts';

/**
 * Default release tag hosting published knowledge-pack artifacts. Large packs
 * exceed GitHub's 2 GiB per-asset limit, so each pack is published as a set of
 * multi-part assets plus a `<name>.pack-release.json` index under this tag.
 */
export const DEFAULT_PACK_TAG = 'packs';

/** Filename suffix of the per-pack multi-part release index. */
export const PACK_RELEASE_INDEX_SUFFIX = '.pack-release.json';
