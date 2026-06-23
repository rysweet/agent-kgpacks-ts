// @kgpacks/backend — small value-coercion helpers.
//
// LadybugDB returns INT64 columns as `number | bigint` and column values as
// `unknown`; these helpers normalize them into the strict response shapes without
// scattering casts across the services.

/** Coerces a driver value to a JS number (handles `bigint`). */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Coerces a column value to a string; `null`/`undefined` map to `''`. */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** Coerces a nullable category column to `string | null`. */
export function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/** Clamps a number into the closed unit interval `[0, 1]`. */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Rounds to one decimal place, matching the reference `round(x, 1)` outputs. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Coerces a stored embedding column into a plain numeric array. */
export function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((v) => toNumber(v));
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>, (v) => Number(v));
  }
  return [];
}
