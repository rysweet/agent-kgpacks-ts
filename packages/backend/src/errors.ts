// @kgpacks/backend — error model.
//
// Every failure surfaced by the API uses one envelope shape:
//   { error: { code, message, details }, timestamp }
// `ApiError` carries an HTTP status + a stable machine code; the server's global
// error handler renders it (and Fastify validation / 404 / rate-limit failures)
// into this envelope. Ported from the reference backend's JSONResponse error bodies.

/** Stable machine-readable error codes returned in the envelope. */
export type ErrorCode =
  | 'MISSING_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'INVALID_PACK_NAME'
  | 'NOT_FOUND'
  | 'PACK_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_ERROR'
  | 'INTERNAL_ERROR';

/** The standard error envelope serialized to clients. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown> | null;
  };
  timestamp: string;
}

/**
 * An error carrying the HTTP status + envelope `code`/`message` to return.
 *
 * Services throw these (e.g. `ApiError.notFound()`); routes let them propagate to
 * the global error handler, which renders the envelope.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /** `404 NOT_FOUND` — the requested article/seed does not exist. */
  static notFound(message = 'Article not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  /** `400 INVALID_PARAMETER` — a parameter failed validation. */
  static invalidParameter(message = 'Invalid parameter'): ApiError {
    return new ApiError(400, 'INVALID_PARAMETER', message);
  }
}

/** Current time as an ISO-8601 string with a trailing `Z` (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Builds the standard error envelope. */
export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): ErrorEnvelope {
  return { error: { code, message, details }, timestamp: nowIso() };
}
