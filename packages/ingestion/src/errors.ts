// @kgpacks/ingestion — error types.
//
// A small, typed error surface so callers and tests can distinguish a blocked
// (SSRF) URL from a transport/fetch failure from a malformed-extraction failure.

/** Base class for every error this package throws. */
export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A URL was rejected by the SSRF gate (non-HTTPS, embedded credentials, missing
 * host, or a host that resolves to a private/loopback/reserved/link-local
 * address — including across a redirect).
 */
export class BlockedUrlError extends IngestionError {
  constructor(
    message: string,
    /** The offending URL (host only is meaningful; no secrets are carried). */
    readonly url: string,
  ) {
    super(message);
  }
}

/** A network-level or HTTP-status failure while fetching a source. */
export class FetchError extends IngestionError {
  constructor(
    message: string,
    readonly url: string,
    /** HTTP status when the failure was an unacceptable response code. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The extractor produced output that could not be coerced into the contract. */
export class ExtractionError extends IngestionError {}
