// Upstream-compatible JSON serialization.
//
// The upstream `mcp_server` returns tool results via `json.dumps`. Two formats
// are used and must be reproduced byte-for-byte:
//   - success paths: `json.dumps(value, indent=2)` (pretty, 2-space),
//   - error paths:   `json.dumps(value)` (compact, but with upstream's default
//     `", "` / `": "` separators — which differ from `JSON.stringify`'s
//     separator-less compact form).
//
// For ASCII content `JSON.stringify(value, null, 2)` is byte-identical to
// upstream's `indent=2` output, so {@link dumpIndented} delegates to it. The
// compact form is reconstructed by {@link dumpCompact} for the flat error
// objects the server emits.

/** Matches upstream `json.dumps(value, indent=2)` (ASCII content). */
export function dumpIndented(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Matches upstream `json.dumps(value)` (default compact separators `", "` / `": "`)
 * for a flat object of JSON-serializable values — the shape of every error
 * payload the server returns. Each key and value is escaped with
 * `JSON.stringify`, then joined with upstream's separators.
 */
export function dumpCompact(value: Record<string, unknown>): string {
  const entries = Object.entries(value).map(
    ([key, val]) => `${JSON.stringify(key)}: ${JSON.stringify(val)}`,
  );
  return `{${entries.join(', ')}}`;
}
