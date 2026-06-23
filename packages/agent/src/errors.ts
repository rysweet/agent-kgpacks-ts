// @kgpacks/agent — error taxonomy.
//
// The agent fails closed: it returns valid, shape-checked data or throws one of
// these. `AgentError` is the catch-all base (instanceof AgentError catches all).
// Errors never carry BYOK secrets — `AgentTransportError.cause` is redacted by
// the caller (see copilot-agent.ts), and `AgentResponseFormatError.rawContent`
// is size-capped for safe diagnostics.

import { MAX_RAW_CONTENT_CHARS } from './constants.js';

/** Base class for every error this package throws. */
export class AgentError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentError';
    // Preserve the prototype chain so `instanceof` holds across transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation is used before `start()` or after `stop()`. */
export class AgentNotStartedError extends AgentError {
  constructor(message = 'CopilotAgent is not started — call start() before using it.') {
    super(message);
    this.name = 'AgentNotStartedError';
  }
}

/**
 * Thrown for any SDK start/session/send/timeout/stop failure. The underlying
 * cause is attached but is redacted of provider config (apiKey/bearerToken/
 * headers) before it is surfaced.
 */
export class AgentTransportError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentTransportError';
  }
}

/**
 * Thrown when model content is empty, not valid JSON after fence-stripping, or
 * not the expected shape (e.g. not a `string[]`). Carries a size-capped copy of
 * the offending output for diagnostics.
 */
export class AgentResponseFormatError extends AgentError {
  readonly rawContent: string;

  constructor(message: string, rawContent = '') {
    super(message);
    this.name = 'AgentResponseFormatError';
    this.rawContent =
      rawContent.length > MAX_RAW_CONTENT_CHARS
        ? rawContent.slice(0, MAX_RAW_CONTENT_CHARS)
        : rawContent;
  }
}
