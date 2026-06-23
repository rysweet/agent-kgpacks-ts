// apps/frontend/src/api/errors.ts
//
// The single error type for the whole client. Every failure — an HTTP error
// envelope, a transport failure, a malformed body, or an SSE error — is
// normalized into an `ApiClientError` carrying `code`, `status`, and `message`.
// See docs/packages/frontend.md#error-model.

export type ApiErrorCode =
  | 'MISSING_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'INVALID_PACK_NAME'
  | 'NOT_FOUND'
  | 'PACK_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_ERROR'
  | 'TIMEOUT' // SSE: "TimeoutError"
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'; // fetch reject / EventSource pre-stream failure

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly details: unknown | null;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number | null = null,
    details: unknown | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
    // Restore the prototype chain (so `instanceof` works after transpilation).
    Object.setPrototypeOf(this, ApiClientError.prototype);
  }
}

/** Maps an HTTP status to a code when the body is not a well-formed envelope. */
export function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_PARAMETER';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'AGENT_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

interface ErrorEnvelope {
  code: ApiErrorCode;
  message: string;
  details: unknown | null;
}

/** Extracts `{ error: { code, message, details } }`, or null if not well-formed. */
function parseEnvelope(body: unknown): ErrorEnvelope | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const details = (error as { details?: unknown }).details ?? null;
  return { code: code as ApiErrorCode, message, details };
}

/**
 * Builds an `ApiClientError` from a non-2xx `Response`. Reads the backend's
 * `{ error, timestamp }` envelope when present; otherwise falls back to the
 * status→code map with a generic message. Never throws.
 */
export async function errorFromResponse(response: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined; // non-JSON body (e.g. a gateway HTML page)
  }
  const envelope = parseEnvelope(body);
  if (envelope) {
    return new ApiClientError(envelope.code, envelope.message, response.status, envelope.details);
  }
  return new ApiClientError(
    statusToCode(response.status),
    `Request failed with status ${response.status}.`,
    response.status,
    null,
  );
}
