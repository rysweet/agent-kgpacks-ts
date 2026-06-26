// @kgpacks/agent — constants.
//
// The pinned BYOK synthesis model and the safety/DoS caps applied before any
// prompt reaches the transport. Per docs/PLAN.md the model is *held constant* so
// the SDK only changes transport; changing DEFAULT_SYNTHESIS_MODEL is a
// re-baseline event, not a routine config change.

/**
 * BYOK model used for every operation, held constant per run. The reference (wikigr) baseline
 * model is not vendored in this repo; this is the documented, constructor-
 * overridable default (see docs/packages/agent.md "Versioning strategy").
 */
export const DEFAULT_SYNTHESIS_MODEL = 'claude-opus-4.8';

/** Max retrieved chunks forwarded to synthesis (deterministic head truncation). */
export const MAX_CONTEXT_CHUNKS = 50;

/** Max characters of any single chunk's text included in a prompt. */
export const MAX_CHUNK_CHARS = 8_000;

/** Max total characters of context text included across all chunks. */
export const MAX_CONTEXT_CHARS = 60_000;

/** Default number of reformulations/variants for expand/multi-query. */
export const DEFAULT_LIST_COUNT = 3;

/** Lower/upper clamps for caller-supplied list counts and seed limits. */
export const MIN_LIST_COUNT = 1;
export const MAX_LIST_COUNT = 20;
export const MAX_SEED_LIMIT = 100;

/** Diagnostics cap: how much offending model output an error may carry. */
export const MAX_RAW_CONTENT_CHARS = 2_048;
