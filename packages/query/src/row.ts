// @kgpacks/query — result-row coercion helpers.
//
// LadybugDB returns INT64 primary keys as `number | bigint` and column values as
// `unknown`. These helpers normalize them into the strict public shapes without
// scattering casts across the retrieval modules.

/** Stringifies a node primary key, preserving full precision for `bigint`. */
export function toIdString(value: unknown): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

/** Coerces a column value to a string, mapping `null`/`undefined` to `''`. */
export function coerceContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === null || value === undefined ? '' : String(value);
}

/** Clamps a number into the closed unit interval `[0, 1]`. */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
