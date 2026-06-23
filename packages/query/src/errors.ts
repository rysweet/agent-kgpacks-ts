// @kgpacks/query — error taxonomy.
//
// Fails closed: retrieval returns valid results or throws one of these.
// `QueryError` is the catch-all base (instanceof QueryError catches all).

/** Base class for every error this package throws. */
export class QueryError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QueryError';
    // Preserve the prototype chain so `instanceof` holds across transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link validateCypher} when a query fails the read-only allow-list:
 * a non-`MATCH`/`CALL` prefix, a blocked write/DDL keyword, or a variable-length
 * path pattern. The message names the specific reason for fail-closed auditing.
 */
export class CypherValidationError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = 'CypherValidationError';
  }
}
