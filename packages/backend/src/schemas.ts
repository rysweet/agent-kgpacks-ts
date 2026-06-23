// @kgpacks/backend — JSON schemas for request validation.
//
// Each route attaches one of these to Fastify so query/path/body parameters are
// validated and coerced (integers, numbers) before the handler runs. A validation
// failure is rendered as the standard `400` envelope by the global error handler
// (`MISSING_PARAMETER` for an absent required field, else `INVALID_PARAMETER`).
//
// Ranges mirror the reference FastAPI `Query(...)` / Pydantic `Field(...)` bounds.
// Note: the chat `pack` pattern is intentionally NOT enforced here — the handler
// checks it so a bad value returns `INVALID_PACK_NAME` rather than the generic
// `INVALID_PARAMETER`.

export const chatBodySchema = {
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    pack: { type: 'string' },
    max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
} as const;

export const chatStreamQuerySchema = {
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    max_results: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
} as const;

export const searchQuerySchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', maxLength: 200 },
    category: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    threshold: { type: 'number', minimum: 0, maximum: 1, default: 0 },
  },
} as const;

export const hybridQuerySchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', maxLength: 200 },
    category: { type: 'string', maxLength: 200 },
    max_hops: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
} as const;

export const graphQuerySchema = {
  type: 'object',
  required: ['article'],
  properties: {
    article: { type: 'string', maxLength: 500 },
    depth: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    category: { type: 'string', maxLength: 200 },
  },
} as const;

export const articleParamsSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', maxLength: 500 },
  },
} as const;

export const autocompleteQuerySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 2, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
  },
} as const;
