// @kgpacks/query — Cypher safety validation.
//
// A read-only allow-list / write-blocklist for Cypher, ported with strict parity
// from the reference `KnowledgeGraphAgent._validate_cypher`
// (rysweet/agent-kgpacks wikigr/agent kg_agent module). It fails closed: a query is
// rejected unless it provably matches the read-only contract.
//
// The CORE retrieval path (`retrieve`) does NOT route user text into Cypher — it
// runs fixed, parameter-bound vector/graph queries — so this is exported as a
// standalone guard for any caller that builds Cypher from untrusted input.

import { CYPHER_ALLOWED_PREFIXES, CYPHER_BLOCKED_OPS } from './constants.js';
import { CypherValidationError } from './errors.js';

// Pre-compiled patterns (parity with the reference module-level constants).
const STRIP_DOUBLE_QUOTED = /"[^"]*"/g;
const STRIP_SINGLE_QUOTED = /'[^']*'/g;
const ALPHA_TOKENS = /[A-Za-z]+/g;
// Matches any bracketed variable-length path segment (contains `*`). The reference
// name says "unbounded" but the regex also matches bounded forms like
// `[:LINKS_TO*1..3]`; strict parity rejects both.
const VARIABLE_LENGTH_PATH = /\[[\w:]*\*[^\]]*\]/;

/**
 * Validates that `cypher` is a read-only query and throws otherwise.
 *
 * The checks, in order (matching the reference exactly):
 *  1. String literals are stripped so quoted keywords (e.g. `"DELETE ME"`) never
 *     trip the blocklist.
 *  2. The trimmed, upper-cased remainder must start with `MATCH` or `CALL`.
 *  3. No bare alphabetic token may be a write/DDL keyword
 *     (`CREATE/DELETE/DROP/SET/MERGE/REMOVE/DETACH`).
 *  4. The original query must contain no variable-length path (`[...*...]`).
 *
 * @throws {CypherValidationError} on the first failing check.
 */
export function validateCypher(cypher: string): void {
  // 1. Strip string literals to avoid false positives on quoted content.
  const stripped = cypher.replace(STRIP_DOUBLE_QUOTED, '""').replace(STRIP_SINGLE_QUOTED, "''");

  const upper = stripped.trim().toUpperCase();

  // 2. Prefix check — must start with an allowed read keyword.
  if (!CYPHER_ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    throw new CypherValidationError('Cypher query must start with MATCH or CALL');
  }

  // 3. Block dangerous write/DDL keywords (first hit wins, like the reference).
  const tokens = stripped.match(ALPHA_TOKENS) ?? [];
  for (const token of tokens) {
    const keyword = token.toUpperCase();
    if (CYPHER_BLOCKED_OPS.has(keyword)) {
      throw new CypherValidationError(`Write operation rejected: ${keyword}`);
    }
  }

  // 4. Block variable-length paths (checked against the ORIGINAL query).
  if (VARIABLE_LENGTH_PATH.test(cypher)) {
    throw new CypherValidationError('Unbounded variable-length path detected in query');
  }
}
